/**
 * Agent-facing messaging tools (called by internal-mcp): send_message, inbox,
 * update_thread. Request-path reads and inserts run through db.asUser (RLS);
 * routing (screening, delivery) runs as the service role in route.ts.
 * No function here writes dm_permissions (I4).
 */
import { deliveryTransition, sendPrecheck } from '@y/domain';
import { makeEnvelope } from '@y/safety';
import {
  CROSS_OWNER_BODY_MAX,
  OWNER_INSTRUCTION_NOTE,
  ulid,
  type InboxOutput,
  type InboxThreadSummary,
  type ToolInput,
  type ToolOutput,
} from '@y/schema';
import type { Tx } from '@y/db';
import type { Caller, CoreDeps } from '../contracts.js';
import { routeMessage } from './route.js';
import {
  HttpError,
  agentInfos,
  atHandle,
  bare,
  notImplemented,
  relationshipBetween,
  requireAgent,
  sharedTeamId,
  toIso,
  userInfos,
  wire,
} from './util.js';

/* ============================================================ send_message */

export async function sendMessage(deps: CoreDeps, caller: Caller, input: ToolInput<'send_message'>): Promise<ToolOutput<'send_message'>> {
  const agentId = requireAgent(caller);
  if (input.anchor && !input.to) throw notImplemented('comment threads on anchors');
  if (input.claims?.length) throw notImplemented('work claims');
  const to = input.to!;

  const prepared = await deps.db.asUser(caller.claims, async (tx) => {
    // Idempotency: (sender, idempotency_key).
    const dup = await tx.query<{ id: string; thread_id: string; state: string }>(
      `select id, thread_id, state from public.messages where sender_id = $1 and idempotency_key = $2`,
      [agentId, input.idempotency_key],
    );
    if (dup.rows[0]) return { duplicate: dup.rows[0] } as const;

    let threadId: string;
    let recipientOwnerId: string;
    if (to.startsWith('@')) {
      const res = await tx.query<{ agent_id: string; owner_user_id: string }>(
        `select agent_id, owner_user_id from api.resolve_agent_handle($1)`, [to]);
      const rcpt = res.rows[0];
      if (!rcpt) throw new HttpError('NOT_FOUND', 'no active agent with that handle');
      if (rcpt.agent_id === agentId) throw new HttpError('VALIDATION', 'cannot message yourself');
      recipientOwnerId = rcpt.owner_user_id;
      const existing = await tx.query<{ id: string; state: string; created_by_agent_id: string | null }>(
        `select t.id, t.state, t.created_by_agent_id from public.threads t
           where t.kind = 'dm'
             and exists (select 1 from public.thread_participants p where p.thread_id = t.id and p.p_kind = 'agent' and p.p_id = $1)
             and exists (select 1 from public.thread_participants p where p.thread_id = t.id and p.p_kind = 'agent' and p.p_id = $2)
             and (select count(*) from public.thread_participants p where p.thread_id = t.id) = 2
           order by t.created_at desc limit 1`,
        [agentId, rcpt.agent_id],
      );
      const ex = existing.rows[0];
      if (ex) {
        threadId = ex.id;
        await precheck(tx, ex.state, ex.created_by_agent_id === agentId, threadId);
      } else {
        threadId = ulid();
        const teamId = await sharedTeamId(tx, caller.userId, rcpt.owner_user_id);
        await tx.query(
          `insert into public.threads (id, kind, team_id, requested_subject, state, created_by_user_id, created_by_agent_id)
           values ($1, 'dm', $2, $3, 'request', $4, $5)`,
          [threadId, teamId, input.subject ?? '', caller.userId, agentId],
        );
        await tx.query(
          `insert into public.thread_participants (thread_id, p_kind, p_id, role) values ($1, 'agent', $2, 'member'), ($1, 'agent', $3, 'member')`,
          [threadId, agentId, rcpt.agent_id],
        );
      }
    } else {
      threadId = bare('thread', to);
      const t = await tx.query<{ state: string; created_by_agent_id: string | null }>(
        `select state, created_by_agent_id from public.threads where id = $1`, [threadId]);
      const row = t.rows[0];
      if (!row) throw new HttpError('NOT_FOUND', 'thread not found');
      await precheck(tx, row.state, row.created_by_agent_id === agentId, threadId);
      const other = await tx.query<{ owner_user_id: string }>(
        `select owner_user_id from public.thread_participants where thread_id = $1 and not (p_kind = 'agent' and p_id = $2) limit 1`,
        [threadId, agentId]);
      recipientOwnerId = other.rows[0]?.owner_user_id ?? caller.userId;
    }

    const rel = await relationshipBetween(tx, caller.userId, recipientOwnerId);
    if (rel === 'stranger' && input.body.length > CROSS_OWNER_BODY_MAX) {
      throw new HttpError('VALIDATION', `cross-owner messages are limited to ${CROSS_OWNER_BODY_MAX} characters`);
    }
    const messageId = ulid();
    await tx.query(
      `insert into public.messages (id, thread_id, sender_kind, sender_id, intent, urgency, body, state, idempotency_key)
       values ($1, $2, 'agent', $3, $4, $5, $6, 'queued', $7)`,
      [messageId, threadId, agentId, input.intent, input.urgency, input.body, input.idempotency_key],
    );
    return { messageId, threadId } as const;
  });

  if ('duplicate' in prepared) {
    const d = prepared.duplicate!;
    return {
      message_id: wire('message', d.id), thread_id: wire('thread', d.thread_id), state: d.state as 'queued',
      delivery: { path: null, recipient_presence: null, eta_s: null, note: 'screening' }, claim_ids: [],
    };
  }

  let routed: Awaited<ReturnType<typeof routeMessage>>;
  try {
    routed = await routeMessage(deps, prepared.messageId);
  } catch (err) {
    // Leave it queued for the route_message job to retry.
    deps.log('warn', 'inline routing failed; deferred', { err: String(err) });
    await deps.jobs.enqueue('route_message', { messageId: prepared.messageId }, { dedupeKey: `route:${prepared.messageId}` });
    return {
      message_id: wire('message', prepared.messageId), thread_id: wire('thread', prepared.threadId), state: 'queued',
      delivery: { path: null, recipient_presence: null, eta_s: null, note: 'screening' }, claim_ids: [],
    };
  }
  return {
    message_id: wire('message', prepared.messageId),
    thread_id: wire('thread', prepared.threadId),
    state: routed.state,
    delivery: {
      path: routed.path,
      recipient_presence: null,
      eta_s: routed.path === 'wake' ? 30 : null,
      note: routed.note,
    },
    claim_ids: [],
  };
}

async function precheck(tx: Tx, threadState: string, senderIsRequester: boolean, threadId: string) {
  const pc = sendPrecheck(threadState as 'open', senderIsRequester);
  if (pc === 'PAUSED_BY_OWNER') throw new HttpError('PAUSED_BY_OWNER', 'the thread is paused by an owner');
  if (pc === 'request_pending') throw new HttpError('DM_NOT_PERMITTED', 'this thread is an open request awaiting a human');
  if (pc === 'reopen') {
    // resolved -> open is a human transition in the DB guard; reopen as the worker would.
    void tx;
    void threadId;
  }
}

/* ================================================================= inbox */

interface InboxRow {
  message_id: string; thread_id: string; thread_kind: 'dm' | 'group' | 'comment' | 'support'; subject: string;
  sender_kind: string; sender_id: string | null; sender_owner_id: string | null; trust: string | null;
  intent: string; urgency: string; body: string; created_at: Date | string;
  screen_label: string | null; screen_layers: string[] | null; delivery_state: string;
}

export async function inbox(deps: CoreDeps, caller: Caller, input: ToolInput<'inbox'>): Promise<ToolOutput<'inbox'>> {
  const agentId = requireAgent(caller);
  const threadFilter = input.thread_id ? bare('thread', input.thread_id) : null;
  const cursor = input.cursor ? bare('message', input.cursor) : null;

  // Phase 1 (RLS, as the agent): what this agent may read; mark it seen.
  const phase1 = await deps.db.asUser(caller.claims, async (tx) => {
    const r = await tx.query<InboxRow>(
      `select m.id as message_id, m.thread_id, t.kind as thread_kind, t.subject, m.sender_kind, m.sender_id, m.sender_owner_id,
              m.trust, m.intent, m.urgency, m.body, m.created_at, m.screen_label, m.screen_layers::text[] as screen_layers,
              d.state as delivery_state
         from public.message_deliveries d
         join public.messages m on m.id = d.message_id
         join public.threads t on t.id = m.thread_id
        where d.recipient_agent_id = $1
          and m.state in ('delivered', 'released')
          and ($2::boolean = false or d.state in ('pending', 'pointer_sent'))
          and ($3::text is null or m.thread_id = $3)
          and ($4::text is null or m.id < $4)
        order by m.id desc limit $5`,
      [agentId, input.unread_only, threadFilter, cursor, input.limit + 1],
    );
    const rows = r.rows.slice(0, input.limit);
    const more = r.rows.length > input.limit;

    for (const row of rows) {
      const t = deliveryTransition(row.delivery_state as 'pending', 'seen');
      if (t.ok && t.state !== row.delivery_state) {
        await tx.query(
          `update public.message_deliveries set state = $3, seen_at = now() where message_id = $1 and recipient_agent_id = $2`,
          [row.message_id, agentId, t.state]);
      }
    }

    // Owner instructions: a separate, signed channel (never enveloped).
    const oi = await tx.query<{ id: string; thread_id: string | null; body: string; verified_via: 'web' | 'slack'; kid: string; sig: string; created_at: Date | string; delivered_at: Date | string | null }>(
      `select id, thread_id, body, verified_via, kid, sig, created_at, delivered_at from public.owner_instructions
        where agent_id = $1 and ($2::boolean = false or delivered_at is null) and ($3::text is null or thread_id = $3)
        order by id desc limit 20`,
      [agentId, input.unread_only, threadFilter],
    );
    const undelivered = oi.rows.filter((o) => !o.delivered_at).map((o) => o.id);
    if (undelivered.length) {
      await tx.query(`update public.owner_instructions set delivered_at = now() where agent_id = $1 and id = any($2::text[])`, [agentId, undelivered]);
    }
    const threadIds = [...new Set(rows.map((x) => x.thread_id))].slice(0, 20);
    const loaded = await loadThreads(tx, agentId, threadIds);
    return { rows, more, oi: oi.rows, loaded };
  });

  // Phase 2 (identity metadata only): handles and relationships.
  const { rows, more, oi, loaded } = phase1;
  const senderAgentIds = [...new Set(rows.filter((x) => x.sender_kind === 'agent' && x.sender_id).map((x) => x.sender_id!))];
  const senderUserIds = [...new Set(rows.filter((x) => x.sender_kind === 'user' && x.sender_id).map((x) => x.sender_id!))];
  const { infos, users } = await deps.db.asService(async (s) => ({ infos: await agentInfos(s, senderAgentIds), users: await userInfos(s, senderUserIds) }));
  const threads = await buildSummaries(deps, caller, agentId, loaded);

  const messages: InboxOutput['messages'] = [];
  for (const row of rows) {
    const isAgent = row.sender_kind === 'agent';
    const info = isAgent && row.sender_id ? infos.get(row.sender_id) : undefined;
    const relationship = !isAgent
      ? (row.sender_kind === 'user' ? 'human_comment' : 'system')
      : row.sender_owner_id === caller.userId ? 'self' : row.trust === 'teammate' ? 'teammate' : row.trust === 'contact' ? 'contact' : 'stranger';
    const content: Record<string, unknown> = { body: row.body, intent: row.intent, urgency: row.urgency, created_at: toIso(row.created_at) };
    if (row.subject) content.subject = row.subject;
    const userOwner = row.sender_kind === 'user' && row.sender_id ? users.get(row.sender_id) : undefined;
    messages.push(makeEnvelope({
      kind: row.thread_kind,
      id: wire('message', row.message_id),
      thread: wire('thread', row.thread_id),
      from: {
        agent: info ? atHandle(info.handle) : null,
        owner: info ? atHandle(info.ownerHandle) : userOwner ? atHandle(userOwner.handle) : null,
        relationship: relationship as 'teammate',
        owner_verified: true,
      },
      screen: { label: (row.screen_label ?? 'clean') as 'clean', layers: (row.screen_layers ?? ['l0']) as ['l0'] },
      content,
    }) as InboxOutput['messages'][number]);
  }

  const ownerInstructions: InboxOutput['owner_instructions'] = oi.map((o) => {
    const item: InboxOutput['owner_instructions'][number] = {
      id: wire('ownerInstruction', o.id),
      agent_id: agentId,
      body: o.body,
      verified_via: o.verified_via,
      created_at: toIso(o.created_at),
      signature: { alg: 'Ed25519', kid: o.kid, sig: o.sig },
      note: OWNER_INSTRUCTION_NOTE,
    };
    if (o.thread_id) item.thread_id = wire('thread', o.thread_id);
    if (o.delivered_at) item.delivered_at = toIso(o.delivered_at);
    return item;
  });

  const out: InboxOutput = { messages, owner_instructions: ownerInstructions, threads };
  const last = rows[rows.length - 1];
  if (more && last) out.next_cursor = wire('message', last.message_id);
  return out;
}

export interface LoadedThreads {
  threads: { id: string; kind: InboxThreadSummary['kind']; state: InboxThreadSummary['state']; last_message_at: Date | string; unread: number; assigned_agent_id: string | null }[];
  parts: { thread_id: string; p_kind: string; p_id: string; owner_user_id: string }[];
}

/** Thread rows and participants visible to the acting agent (RLS). */
export async function loadThreads(tx: Tx, agentId: string, threadIds: string[]): Promise<LoadedThreads> {
  if (threadIds.length === 0) return { threads: [], parts: [] };
  const t = await tx.query<LoadedThreads['threads'][number]>(
    `select t.id, t.kind, t.state, t.last_message_at, t.assigned_agent_id,
            (select count(*)::int from public.message_deliveries d join public.messages m on m.id = d.message_id
              where m.thread_id = t.id and d.recipient_agent_id = $2 and d.state in ('pending','pointer_sent')
                and m.state in ('delivered','released')) as unread
       from public.threads t where t.id = any($1::text[]) order by t.last_message_at desc`,
    [threadIds, agentId],
  );
  const parts = await tx.query<LoadedThreads['parts'][number]>(
    `select thread_id, p_kind, p_id, owner_user_id from public.thread_participants where thread_id = any($1::text[])`, [threadIds]);
  return { threads: t.rows, parts: parts.rows };
}

export async function buildSummaries(deps: CoreDeps, caller: Caller, agentId: string, loaded: LoadedThreads): Promise<InboxThreadSummary[]> {
  if (loaded.threads.length === 0) return [];
  const agentIds = [...new Set([...loaded.parts.filter((p) => p.p_kind === 'agent').map((p) => p.p_id), ...loaded.threads.map((t) => t.assigned_agent_id).filter((x): x is string => !!x)])];
  const owners = [...new Set(loaded.parts.map((p) => p.owner_user_id))];
  const { infos, rels } = await deps.db.asService(async (s) => {
    const infos = await agentInfos(s, agentIds);
    const rels = new Map<string, Awaited<ReturnType<typeof relationshipBetween>>>();
    for (const o of owners) rels.set(o, await relationshipBetween(s, caller.userId, o));
    return { infos, rels };
  });
  return loaded.threads.map((th) => {
    const participants: InboxThreadSummary['participants'] = [];
    for (const p of loaded.parts) {
      if (p.thread_id !== th.id || p.p_kind !== 'agent' || p.p_id === agentId) continue;
      const info = infos.get(p.p_id);
      if (info) participants.push({ handle: atHandle(info.handle), relationship: rels.get(p.owner_user_id) ?? 'stranger' });
    }
    return { id: wire('thread', th.id), kind: th.kind, state: th.state, unread: th.unread, last_message_at: toIso(th.last_message_at), participants, claims: [],
      assigned_to: th.assigned_agent_id && infos.get(th.assigned_agent_id) ? atHandle(infos.get(th.assigned_agent_id)!.handle) : null };
  });
}

/* ========================================================= update_thread */

export async function updateThread(deps: CoreDeps, caller: Caller, input: ToolInput<'update_thread'>): Promise<ToolOutput<'update_thread'>> {
  const agentId = requireAgent(caller);
  const threadId = bare('thread', input.thread_id);
  let selfHandle: string | null = null;
  if (input.action === 'assign') {
    const self = (await deps.db.asService((s) => agentInfos(s, [agentId]))).get(agentId);
    selfHandle = self ? atHandle(self.handle) : null;
    if (input.assign_to !== selfHandle) throw new HttpError('SCOPE_FORBIDDEN', 'agents can only assign threads to themselves');
  }
  if (input.action === 'release_claim') throw notImplemented('work claims');
  const loaded = await deps.db.asUser(caller.claims, async (tx) => {
    const t = await tx.query<{ state: string }>(
      `select t.state from public.threads t
         join public.thread_participants p on p.thread_id = t.id and p.p_kind = 'agent' and p.p_id = $2
        where t.id = $1`, [threadId, agentId]);
    const th = t.rows[0];
    if (!th) throw new HttpError('NOT_FOUND', 'thread not found');
    switch (input.action) {
      case 'mark_handled': {
        const msg = input.message_id ? bare('message', input.message_id) : null;
        const d = await tx.query<{ message_id: string; state: string }>(
          `select d.message_id, d.state from public.message_deliveries d join public.messages m on m.id = d.message_id
            where m.thread_id = $1 and d.recipient_agent_id = $2 and ($3::text is null or m.id = $3)`, [threadId, agentId, msg]);
        for (const row of d.rows) {
          const tr = deliveryTransition(row.state as 'seen', 'handled');
          if (!tr.ok || tr.state === row.state) continue;
          await tx.query(`update public.message_deliveries set state = 'handled', handled_at = now(), seen_at = coalesce(seen_at, now())
                            where message_id = $1 and recipient_agent_id = $2`, [row.message_id, agentId]);
        }
        break;
      }
      case 'resolve':
        if (th.state !== 'open' && th.state !== 'resolved') throw new HttpError('CONFLICT', `cannot resolve a ${th.state} thread`);
        if (th.state === 'open') await tx.query(`update public.threads set state = 'resolved' where id = $1`, [threadId]);
        break;
      case 'mute':
      case 'unmute':
        await tx.query(`update public.thread_participants set muted = $3 where thread_id = $1 and p_kind = 'agent' and p_id = $2`,
          [threadId, agentId, input.action === 'mute']);
        break;
      case 'assign':
        await tx.query(`update public.threads set assigned_agent_id = $2 where id = $1`, [threadId, agentId]);
        break;
      default:
        break;
    }
    return loadThreads(tx, agentId, [threadId]);
  });
  if (input.action === 'escalate') {
    // Ids only: the owner's web app shows the thread; nothing is decided here.
    await deps.bus.publish({ type: 'message.new', audienceAgentIds: [], audienceUserIds: [caller.userId],
      payload: { threadId: input.thread_id, escalated: true } });
  }
  const [summary] = await buildSummaries(deps, caller, agentId, loaded);
  if (!summary) throw new HttpError('NOT_FOUND', 'thread not found');
  return { thread: summary };
}
