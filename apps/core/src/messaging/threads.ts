/**
 * Web thread routes (docs/UI.md §4): list, start a DM (own or a teammate's
 * agent), messages, comment, instruct, pause, resolve, reopen. Human web
 * callers only; reads and inserts through db.asUser (RLS); owner
 * instructions are signed and stored by core. Nothing here writes
 * dm_permissions (I4).
 */
import { pickLeaseSession, type LeaseCandidate } from '@y/domain';
import {
  CommentRequest,
  InstructRequest,
  NewThreadRequest,
  ThreadMessagesQuery,
  ThreadsQuery,
  ulid,
  validationError,
  type InstructResponse,
  type Message,
  type ThreadDetail,
  type Thread,
} from '@y/schema';
import type { Tx } from '@y/db';
import type { App, Caller, CoreDeps } from '../contracts.js';
import { routeMessage } from './route.js';
import { signOwnerInstruction } from './signing.js';
import {
  HttpError,
  agentInfos,
  agentRef,
  bare,
  errorResponse,
  relationshipBetween,
  requireCaller,
  requireHuman,
  sharedTeamId,
  toIso,
  userInfos,
  userRef,
  wire,
} from './util.js';

interface ThreadRow {
  id: string; kind: Thread['kind']; subject: string; state: Thread['state']; last_message_at: Date | string;
  last_body: string | null; last_q: boolean;
}

export const PREVIEW_MAX = 280;

async function loadThreadRows(tx: Tx, userId: string, ids: string[] | null, unreadOnly: boolean) {
  const t = await tx.query<ThreadRow & { unread: number }>(
    `select t.id, t.kind, t.subject, t.state, t.last_message_at,
            (select count(*)::int from public.message_deliveries d join public.messages m on m.id = d.message_id
               join public.agents a on a.id = d.recipient_agent_id
              where m.thread_id = t.id and a.owner_user_id = $1 and d.state in ('pending','pointer_sent')) as unread,
            -- Previews only ever come from delivered/released messages (never quarantined or request_pending).
            (select left(m.body, ${PREVIEW_MAX}) from public.messages m
              where m.thread_id = t.id and m.state in ('delivered','released') order by m.id desc limit 1) as last_body,
            exists (select 1 from public.messages m
              where m.thread_id = t.id and m.state = 'quarantined'
                and m.id > coalesce((select max(x.id) from public.messages x
                                      where x.thread_id = t.id and x.state in ('delivered','released')), '')) as last_q
       from public.threads t
      where ($2::text[] is null or t.id = any($2::text[]))
      order by t.last_message_at desc, t.id desc limit 500`,
    [userId, ids],
  );
  const rows = unreadOnly ? t.rows.filter((r) => r.unread > 0) : t.rows;
  const threadIds = rows.map((r) => r.id);
  const parts = threadIds.length
    ? (await tx.query<{ thread_id: string; p_kind: string; p_id: string; role: Thread['participants'][number]['role']; owner_user_id: string }>(
        `select thread_id, p_kind, p_id, role, owner_user_id from public.thread_participants where thread_id = any($1::text[])`, [threadIds])).rows
    : [];
  return { rows, parts };
}

async function buildThreads(deps: CoreDeps, caller: Caller, loaded: Awaited<ReturnType<typeof loadThreadRows>>): Promise<Thread[]> {
  const agentIds = [...new Set(loaded.parts.filter((p) => p.p_kind === 'agent').map((p) => p.p_id))];
  const userIds = [...new Set(loaded.parts.filter((p) => p.p_kind === 'user').map((p) => p.p_id))];
  const { agents, users, settings } = await deps.db.asService(async (s) => ({
    agents: await agentInfos(s, agentIds),
    users: await userInfos(s, userIds),
    settings: new Map((await s.query<{ agent_id: string; remote_instructions: boolean }>(
      `select agent_id, remote_instructions from public.agent_settings where agent_id = any($1::uuid[])`, [agentIds])).rows
      .map((r) => [r.agent_id, r.remote_instructions])),
  }));
  return loaded.rows.map((t) => {
    const participants: Thread['participants'] = [];
    let owns = false;
    let remoteOn = false;
    for (const p of loaded.parts.filter((x) => x.thread_id === t.id)) {
      if (p.p_kind === 'agent') {
        const a = agents.get(p.p_id);
        if (!a) continue;
        participants.push({ agent: agentRef(a), role: p.role });
        if (a.ownerUserId === caller.userId) { owns = true; remoteOn = remoteOn || settings.get(a.id) === true; }
      } else {
        const u = users.get(p.p_id);
        if (u) participants.push({ user: userRef(u), role: p.role });
      }
    }
    const out: Thread = {
      id: wire('thread', t.id), kind: t.kind, subject: t.subject, state: t.state, participants, claims: [],
      lastMessageAt: toIso(t.last_message_at), unread: t.unread,
      viewer: { canInstruct: owns && remoteOn, remoteInstructionsOn: remoteOn, needsStepUp: false },
    };
    if (t.last_body) out.lastPreview = t.last_body.slice(0, PREVIEW_MAX);
    if (t.last_q) out.lastPreviewQuarantined = true;
    return out;
  });
}

async function threadView(deps: CoreDeps, caller: Caller, threadId: string): Promise<Thread> {
  const loaded = await deps.db.asUser(caller.claims, (tx) => loadThreadRows(tx, caller.userId, [threadId], false));
  const [t] = await buildThreads(deps, caller, loaded);
  if (!t) throw new HttpError('NOT_FOUND', 'thread not found');
  return t;
}

/** The thread and its latest 200 messages (plus owner instructions), as the viewer may read them. */
async function threadDetail(deps: CoreDeps, caller: Caller, threadId: string, cursor: string | null): Promise<ThreadDetail> {
  const thread = await threadView(deps, caller, threadId);
  const { msgs, deliveries, ois } = await deps.db.asUser(caller.claims, async (tx) => {
    const msgs = await tx.query<{ id: string; sender_kind: 'agent' | 'user' | 'system'; sender_id: string | null; trust: Message['trust'] | null;
      intent: Message['intent']; urgency: Message['urgency']; body: string; state: Message['state']; screen_label: string | null;
      screen_layers: string[] | null; created_at: Date | string }>(
      `select id, sender_kind, sender_id, trust, intent, urgency, body, state, screen_label, screen_layers::text[] as screen_layers, created_at
         from public.messages where thread_id = $1 and ($2::text is null or id < $2) order by id desc limit 201`, [threadId, cursor]);
    const ids = msgs.rows.map((m) => m.id);
    const deliveries = ids.length ? (await tx.query<{ message_id: string; recipient_agent_id: string; state: Message['deliveries'][number]['state']; path: Message['deliveries'][number]['path'] | null; seen_at: Date | string | null }>(
      `select message_id, recipient_agent_id, state, path, seen_at from public.message_deliveries where message_id = any($1::text[])`, [ids])).rows : [];
    const ois = (await tx.query<{ id: string; agent_id: string; created_by_user_id: string; body: string; created_at: Date | string; delivered_at: Date | string | null }>(
      `select id, agent_id, created_by_user_id, body, created_at, delivered_at from public.owner_instructions where thread_id = $1 order by id desc limit 50`, [threadId])).rows;
    return { msgs: msgs.rows, deliveries, ois };
  });
  const page = msgs.slice(0, 200);
  const agentIds = [...new Set([...page.filter((m) => m.sender_kind === 'agent' && m.sender_id).map((m) => m.sender_id!), ...deliveries.map((d) => d.recipient_agent_id)])];
  const userIds = [...new Set([...page.filter((m) => m.sender_kind === 'user' && m.sender_id).map((m) => m.sender_id!), ...ois.map((o) => o.created_by_user_id)])];
  const { agents, users } = await deps.db.asService(async (s) => ({ agents: await agentInfos(s, agentIds), users: await userInfos(s, userIds) }));
  const messages: Message[] = [];
  for (const m of page) {
    const sender: Message['sender'] = m.sender_kind === 'agent' && m.sender_id && agents.get(m.sender_id)
      ? { kind: 'agent', agent: agentRef(agents.get(m.sender_id)!) }
      : m.sender_kind === 'user' && m.sender_id && users.get(m.sender_id)
        ? { kind: 'user', user: userRef(users.get(m.sender_id)!) }
        : { kind: 'system' };
    const msg: Message = {
      id: wire('message', m.id), threadId: wire('thread', threadId), sender, trust: m.trust ?? 'system',
      intent: m.intent, urgency: m.urgency, body: m.body, state: m.state, createdAt: toIso(m.created_at),
      deliveries: deliveries.filter((d) => d.message_id === m.id && agents.get(d.recipient_agent_id)).map((d) => {
        const out: Message['deliveries'][number] = { recipient: agentRef(agents.get(d.recipient_agent_id)!), state: d.state, path: d.path ?? 'inbox' };
        if (d.seen_at) out.seenAt = toIso(d.seen_at);
        return out;
      }),
    };
    if (m.screen_label) msg.screen = { label: m.screen_label as 'clean', layers: (m.screen_layers ?? ['l0']) as ['l0'] };
    messages.push(msg);
  }
  // Owner instructions appear in the web view as messages with trust 'owner_instruction'.
  for (const o of ois) {
    const u = users.get(o.created_by_user_id);
    if (!u) continue;
    messages.push({
      id: wire('message', o.id), threadId: wire('thread', threadId), sender: { kind: 'user', user: userRef(u) }, trust: 'owner_instruction',
      intent: 'coordinate', urgency: 'normal', body: o.body, state: o.delivered_at ? 'delivered' : 'queued', createdAt: toIso(o.created_at), deliveries: [],
    });
  }
  messages.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const res: ThreadDetail = { thread, messages };
  const last = page[page.length - 1];
  if (msgs.length > 200 && last) res.nextCursor = wire('message', last.id);
  return res;
}

/** Route inline; on failure leave the message queued for the route_message job (as send_message does). */
async function routeOrDefer(deps: CoreDeps, messageId: string): Promise<Message['state']> {
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
async function commentPrecheck(tx: Tx, callerId: string, threadId: string, state: string, createdBy: string): Promise<void> {
  if (state === 'archived') throw new HttpError('CONFLICT', 'this thread is archived');
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

export function registerThreadRoutes(app: App, deps: CoreDeps): void {
  const human = async (authorization: string | undefined) => {
    const caller = await requireCaller(deps, authorization);
    requireHuman(caller);
    return caller;
  };

  app.get('/api/v1/threads', async (c) => {
    try {
      const caller = await human(c.req.header('authorization'));
      const q = ThreadsQuery.safeParse(c.req.query());
      if (!q.success) return c.json(validationError(q.error), 400);
      const loaded = await deps.db.asUser(caller.claims, (tx) => loadThreadRows(tx, caller.userId, null, q.data.unread === true));
      return c.json(await buildThreads(deps, caller, loaded));
    } catch (err) { return errorResponse(c, err, deps); }
  });

  // Start (or continue) a DM with one of the caller's own agents or a
  // teammate's agent. Strangers are refused: their agents are reachable only
  // through the human-gated request flow (I4). Nothing writes dm_permissions.
  app.post('/api/v1/threads', async (c) => {
    try {
      const caller = await human(c.req.header('authorization'));
      const body = NewThreadRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json(validationError(body.error), 400);
      const messageId = ulid();
      const threadId = await deps.db.asUser(caller.claims, async (tx) => {
        const res = await tx.query<{ agent_id: string; owner_user_id: string }>(
          `select agent_id, owner_user_id from api.resolve_agent_handle($1)`, [body.data.to]);
        const rcpt = res.rows[0];
        if (!rcpt) throw new HttpError('NOT_FOUND', 'no active agent with that handle');
        const rel = await relationshipBetween(tx, caller.userId, rcpt.owner_user_id);
        if (rel !== 'self' && rel !== 'teammate') {
          throw new HttpError('DM_NOT_PERMITTED', "you can start a conversation with your own or a teammate's agent only");
        }
        const existing = await tx.query<{ id: string; state: string; created_by_user_id: string }>(
          `select t.id, t.state, t.created_by_user_id from public.threads t
            where t.kind = 'dm' and t.state <> 'archived'
              and exists (select 1 from public.thread_participants p where p.thread_id = t.id and p.p_kind = 'user' and p.p_id = $1)
              and exists (select 1 from public.thread_participants p where p.thread_id = t.id and p.p_kind = 'agent' and p.p_id = $2)
              and (select count(*) from public.thread_participants p where p.thread_id = t.id) = 2
            order by t.created_at desc limit 1`,
          [caller.userId, rcpt.agent_id]);
        let id: string;
        const ex = existing.rows[0];
        if (ex) {
          id = ex.id;
          await commentPrecheck(tx, caller.userId, id, ex.state, ex.created_by_user_id);
          // Writing again reopens a resolved DM (a human transition the guard allows).
          if (ex.state === 'resolved') await tx.query(`update public.threads set state = 'open' where id = $1`, [id]);
        } else {
          id = ulid();
          const teamId = await sharedTeamId(tx, caller.userId, rcpt.owner_user_id);
          await tx.query(
            `insert into public.threads (id, kind, team_id, requested_subject, state, created_by_user_id, created_by_agent_id)
             values ($1, 'dm', $2, $3, 'request', $4, null)`,
            [id, teamId, body.data.subject ?? '', caller.userId]);
          await tx.query(
            `insert into public.thread_participants (thread_id, p_kind, p_id, role) values ($1, 'user', $2, 'owner'), ($1, 'agent', $3, 'member')`,
            [id, caller.userId, rcpt.agent_id]);
        }
        await tx.query(
          `insert into public.messages (id, thread_id, sender_kind, sender_id, trust, intent, urgency, body, state)
           values ($1, $2, 'user', $3, 'human_comment', 'comment', 'normal', $4, 'queued')`,
          [messageId, id, caller.userId, body.data.body]);
        return id;
      });
      // Opens the thread (request -> open) once delivered; human messages never wake.
      await routeOrDefer(deps, messageId);
      return c.json(await threadDetail(deps, caller, threadId, null));
    } catch (err) { return errorResponse(c, err, deps); }
  });

  app.get('/api/v1/threads/:id/messages', async (c) => {
    try {
      const caller = await human(c.req.header('authorization'));
      const threadId = bare('thread', c.req.param('id'));
      const q = ThreadMessagesQuery.safeParse(c.req.query());
      if (!q.success) return c.json(validationError(q.error), 400);
      const cursor = q.data.cursor ? bare('message', q.data.cursor) : null;
      return c.json(await threadDetail(deps, caller, threadId, cursor));
    } catch (err) { return errorResponse(c, err, deps); }
  });

  app.post('/api/v1/threads/:id/comment', async (c) => {
    try {
      const caller = await human(c.req.header('authorization'));
      const threadId = bare('thread', c.req.param('id'));
      const body = CommentRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json(validationError(body.error), 400);
      const messageId = ulid();
      await deps.db.asUser(caller.claims, async (tx) => {
        const t = await tx.query<{ state: string; created_by_user_id: string }>(
          `select state, created_by_user_id from public.threads where id = $1`, [threadId]);
        const row = t.rows[0];
        if (!row) throw new HttpError('NOT_FOUND', 'thread not found');
        await commentPrecheck(tx, caller.userId, threadId, row.state, row.created_by_user_id);
        await tx.query(
          `insert into public.messages (id, thread_id, sender_kind, sender_id, trust, intent, urgency, body, state)
           values ($1, $2, 'user', $3, 'human_comment', 'comment', 'normal', $4, 'queued')`,
          [messageId, threadId, caller.userId, body.data.body]);
      });
      const routedState = await routeOrDefer(deps, messageId);
      const u = (await deps.db.asService((s) => userInfos(s, [caller.userId]))).get(caller.userId);
      if (!u) throw new HttpError('NOT_FOUND', 'user not found');
      const msg: Message = {
        id: wire('message', messageId), threadId: wire('thread', threadId), sender: { kind: 'user', user: userRef(u) },
        trust: 'human_comment', intent: 'comment', urgency: 'normal', body: body.data.body, state: routedState,
        createdAt: deps.now().toISOString(), deliveries: [],
      };
      return c.json(msg);
    } catch (err) { return errorResponse(c, err, deps); }
  });

  app.post('/api/v1/threads/:id/instruct', async (c) => {
    try {
      const caller = await human(c.req.header('authorization'));
      const threadId = bare('thread', c.req.param('id'));
      const body = InstructRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json(validationError(body.error), 400);
      // The caller must own an agent in this thread, with remote instructions on.
      const target = await deps.db.asUser(caller.claims, async (tx) => {
        const r = await tx.query<{ agent_id: string; remote_instructions: boolean }>(
          `select a.id as agent_id, coalesce(s.remote_instructions, false) as remote_instructions
             from public.thread_participants p join public.agents a on a.id = p.p_id
             left join public.agent_settings s on s.agent_id = a.id
            where p.thread_id = $1 and p.p_kind = 'agent' and a.owner_user_id = $2 limit 1`, [threadId, caller.userId]);
        return r.rows[0];
      });
      if (!target) throw new HttpError('SCOPE_FORBIDDEN', 'you do not own an agent in this thread');
      if (!target.remote_instructions) {
        throw new HttpError('SCOPE_FORBIDDEN', 'remote instructions are off for this agent', {
          next: { humanAction: 'grant_permission', url: `${deps.config.publicUrl}/settings/remote-instructions` },
        });
      }
      const id = ulid();
      const createdAt = deps.now().toISOString();
      const wireId = wire('ownerInstruction', id);
      const signed = signOwnerInstruction(deps.config, {
        id: wireId, agent_id: target.agent_id, thread_id: wire('thread', threadId), body: body.data.body, verified_via: 'web', created_at: createdAt,
      });
      // Stored by core (it holds the signing key) after the ownership checks above.
      const unattended = await deps.db.asService(async (tx) => {
        await tx.query(
          `insert into public.owner_instructions (id, agent_id, thread_id, created_by_user_id, body, verified_via, kid, sig, created_at)
           values ($1, $2, $3, $4, $5, 'web', $6, $7, $8)`,
          [id, target.agent_id, threadId, caller.userId, body.data.body, signed.kid, signed.sig, createdAt]);
        const leases = await tx.query<{ session_id: string; listening: string; last_heartbeat_at: Date | string; permission_mode: string; headless: boolean; last_thread_ids: string[] }>(
          `select session_id, listening, last_heartbeat_at, permission_mode, headless, last_thread_ids from public.session_leases where agent_id = $1`, [target.agent_id]);
        const cands: LeaseCandidate[] = leases.rows.map((l) => ({
          sessionId: l.session_id, listening: l.listening !== 'none', needsApproval: l.listening === 'listening_needs_approval',
          lastHeartbeatAt: new Date(l.last_heartbeat_at).getTime(), lastThreadIds: l.last_thread_ids ?? [],
          permissionMode: l.permission_mode as LeaseCandidate['permissionMode'], headless: l.headless,
        }));
        if (cands.length === 0) return false;
        const attended = pickLeaseSession(cands, { now: deps.now().getTime(), kind: 'owner_instruction', threadId });
        const any = pickLeaseSession(cands, { now: deps.now().getTime(), kind: 'owner_instruction', threadId, ownerConfirmed: true });
        return attended === null && any !== null;
      });
      await deps.bus.publish({ type: 'owner_instruction.new', audienceAgentIds: [target.agent_id], audienceUserIds: [caller.userId],
        payload: { ownerInstructionId: wireId, threadId: wire('thread', threadId) } });
      const res: InstructResponse = { id: wireId as InstructResponse['id'], state: unattended ? 'awaiting_confirm' : 'queued' };
      return c.json(res);
    } catch (err) { return errorResponse(c, err, deps); }
  });

  for (const action of ['pause', 'resolve', 'reopen'] as const) {
    app.post(`/api/v1/threads/:id/${action}`, async (c) => {
      try {
        const caller = await human(c.req.header('authorization'));
        const threadId = bare('thread', c.req.param('id'));
        await deps.db.asUser(caller.claims, async (tx) => {
          const t = await tx.query<{ state: string }>(`select state from public.threads where id = $1`, [threadId]);
          const cur = t.rows[0]?.state;
          if (!cur) throw new HttpError('NOT_FOUND', 'thread not found');
          const next = action === 'pause' ? 'paused_by_owner' : action === 'resolve' ? 'resolved' : 'open';
          const allowed = action === 'pause' ? cur === 'open'
            : action === 'resolve' ? cur === 'open' || cur === 'paused_by_owner'
              : cur === 'paused_by_owner' || cur === 'resolved';
          if (cur === next) return;
          if (!allowed) throw new HttpError('CONFLICT', `cannot ${action} a ${cur} thread`);
          await tx.query(`update public.threads set state = $2 where id = $1`, [threadId, next]);
        });
        return c.json(await threadView(deps, caller, threadId));
      } catch (err) { return errorResponse(c, err, deps); }
    });
  }
}
