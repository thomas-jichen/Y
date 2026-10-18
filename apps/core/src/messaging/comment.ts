/**
 * Human comments (web and Slack): precheck under the human's RLS, insert a
 * `human_comment` message, then route it like any other (L0 `comment`
 * screen, deliveries, ids-only events).
 */
import type { AuthClaims, Tx } from '@y/db';
import { CROSS_OWNER_BODY_MAX, ulid, type Message } from '@y/schema';
import type { CoreDeps } from '../contracts.js';
import { routeMessage } from './route.js';
import { HttpError, relationshipBetween } from './util.js';

/** Route inline; on failure leave the message queued for the route_message job (as send_message does). */
export async function routeOrDefer(deps: CoreDeps, messageId: string): Promise<Message['state']> {
  try {
    return (await routeMessage(deps, messageId)).state;
  } catch (err) {
    deps.log('warn', 'inline routing failed; deferred', { err: String(err) });
    await deps.jobs.enqueue('route_message', { messageId }, { dedupeKey: `route:${messageId}` });
    return 'queued';
  }
}

/**
 * Human comments go to 'open', 'paused_by_owner' and 'resolved' threads.
 * Never to 'archived' ones, and to a 'request' thread only when the caller
 * started it (POST /threads) with their own or teammates' agents: a stranger
 * intro stays closed until the recipient's human accepts it (I4). Routing
 * re-checks the same rule (route.ts).
 */
export async function commentPrecheck(tx: Tx, callerId: string, threadId: string, state: string, createdBy: string, body?: string): Promise<void> {
  if (state === 'archived') throw new HttpError('CONFLICT', 'this thread is archived');
  if (body !== undefined && body.length > CROSS_OWNER_BODY_MAX) {
    // Like send_message: a comment that reaches a stranger's agent has the cross-owner limit.
    // Support threads route human comments by role (support.ts) and are left as they are.
    const agentOwners = await tx.query<{ owner_user_id: string }>(
      `select distinct p.owner_user_id from public.thread_participants p join public.threads t on t.id = p.thread_id
        where p.thread_id = $1 and p.p_kind = 'agent' and t.kind <> 'support'`, [threadId]);
    for (const o of agentOwners.rows) {
      if ((await relationshipBetween(tx, callerId, o.owner_user_id)) === 'stranger') {
        throw new HttpError('VALIDATION', `cross-owner messages are limited to ${CROSS_OWNER_BODY_MAX} characters`);
      }
    }
  }
  if (state !== 'request') return;
  const denied = new HttpError('DM_NOT_PERMITTED', 'this thread is an open request awaiting a human');
  if (createdBy !== callerId) throw denied;
  const owners = await tx.query<{ owner_user_id: string }>(
    `select distinct owner_user_id from public.thread_participants where thread_id = $1 and p_kind = 'agent'`, [threadId]);
  for (const o of owners.rows) {
    const rel = await relationshipBetween(tx, callerId, o.owner_user_id);
    if (rel !== 'self' && rel !== 'teammate') throw denied;
  }
}

/**
 * Post a human comment as `userId` (claims: a web or linked-Slack human
 * context). With an idempotency key, a replay returns the existing message.
 */
export async function postHumanComment(
  deps: CoreDeps,
  a: { userId: string; claims: AuthClaims; threadId: string; body: string; idempotencyKey?: string },
): Promise<{ messageId: string; state: Message['state']; replay: boolean }> {
  const fresh = ulid();
  const { messageId, replay } = await deps.db.asUser(a.claims, async (tx) => {
    const t = await tx.query<{ state: string; created_by_user_id: string }>(
      `select state, created_by_user_id from public.threads where id = $1`, [a.threadId]);
    const row = t.rows[0];
    if (!row) throw new HttpError('NOT_FOUND', 'thread not found');
    if (a.idempotencyKey) {
      const ex = await tx.query<{ id: string }>(
        `select id from public.messages where sender_id = $1 and idempotency_key = $2`, [a.userId, a.idempotencyKey]);
      if (ex.rows[0]) return { messageId: ex.rows[0].id, replay: true };
    }
    await commentPrecheck(tx, a.userId, a.threadId, row.state, row.created_by_user_id, a.body);
    await tx.query(
      `insert into public.messages (id, thread_id, sender_kind, sender_id, trust, intent, urgency, body, state, idempotency_key)
       values ($1, $2, 'user', $3, 'human_comment', 'comment', 'normal', $4, 'queued', $5)`,
      [fresh, a.threadId, a.userId, a.body, a.idempotencyKey ?? null]);
    return { messageId: fresh, replay: false };
  });
  if (replay) {
    const st = await deps.db.asService(async (tx) =>
      (await tx.query<{ state: Message['state'] }>(`select state from public.messages where id = $1`, [messageId])).rows[0]?.state ?? 'queued');
    return { messageId, state: st, replay: true };
  }
  const state = await routeOrDefer(deps, messageId);
  return { messageId, state, replay: false };
}
