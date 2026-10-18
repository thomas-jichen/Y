/**
 * Web thread routes (docs/UI.md §4): list, messages, comment, instruct,
 * pause, resolve. Human web callers only; reads and inserts through
 * db.asUser (RLS); owner instructions are signed and stored by core.
 */
import { pickLeaseSession, type LeaseCandidate } from '@y/domain';
import {
  CommentRequest,
  InstructRequest,
  ThreadMessagesQuery,
  ThreadsQuery,
  ulid,
  validationError,
  type InstructResponse,
  type Message,
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
  requireCaller,
  requireHuman,
  toIso,
  userInfos,
  userRef,
  wire,
} from './util.js';

interface ThreadRow {
  id: string; kind: Thread['kind']; subject: string; state: Thread['state']; last_message_at: Date | string;
}

async function loadThreadRows(tx: Tx, userId: string, ids: string[] | null, unreadOnly: boolean) {
  const t = await tx.query<ThreadRow & { unread: number }>(
    `select t.id, t.kind, t.subject, t.state, t.last_message_at,
            (select count(*)::int from public.message_deliveries d join public.messages m on m.id = d.message_id
               join public.agents a on a.id = d.recipient_agent_id
              where m.thread_id = t.id and a.owner_user_id = $1 and d.state in ('pending','pointer_sent')) as unread
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
    return {
      id: wire('thread', t.id), kind: t.kind, subject: t.subject, state: t.state, participants, claims: [],
      lastMessageAt: toIso(t.last_message_at), unread: t.unread,
      viewer: { canInstruct: owns && remoteOn, remoteInstructionsOn: remoteOn, needsStepUp: false },
    };
  });
}

async function threadView(deps: CoreDeps, caller: Caller, threadId: string): Promise<Thread> {
  const loaded = await deps.db.asUser(caller.claims, (tx) => loadThreadRows(tx, caller.userId, [threadId], false));
  const [t] = await buildThreads(deps, caller, loaded);
  if (!t) throw new HttpError('NOT_FOUND', 'thread not found');
  return t;
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

  app.get('/api/v1/threads/:id/messages', async (c) => {
    try {
      const caller = await human(c.req.header('authorization'));
      const threadId = bare('thread', c.req.param('id'));
      const q = ThreadMessagesQuery.safeParse(c.req.query());
      if (!q.success) return c.json(validationError(q.error), 400);
      const cursor = q.data.cursor ? bare('message', q.data.cursor) : null;
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
      const res: { thread: Thread; messages: Message[]; nextCursor?: string } = { thread, messages };
      const last = page[page.length - 1];
      if (msgs.length > 200 && last) res.nextCursor = wire('message', last.id);
      return c.json(res);
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
        const t = await tx.query(`select 1 from public.threads where id = $1`, [threadId]);
        if (t.rowCount === 0) throw new HttpError('NOT_FOUND', 'thread not found');
        await tx.query(
          `insert into public.messages (id, thread_id, sender_kind, sender_id, trust, intent, urgency, body, state)
           values ($1, $2, 'user', $3, 'human_comment', 'comment', 'normal', $4, 'queued')`,
          [messageId, threadId, caller.userId, body.data.body]);
      });
      const routed = await routeMessage(deps, messageId);
      const u = (await deps.db.asService((s) => userInfos(s, [caller.userId]))).get(caller.userId);
      if (!u) throw new HttpError('NOT_FOUND', 'user not found');
      const msg: Message = {
        id: wire('message', messageId), threadId: wire('thread', threadId), sender: { kind: 'user', user: userRef(u) },
        trust: 'human_comment', intent: 'comment', urgency: 'normal', body: body.data.body, state: routed.state,
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

  for (const action of ['pause', 'resolve'] as const) {
    app.post(`/api/v1/threads/:id/${action}`, async (c) => {
      try {
        const caller = await human(c.req.header('authorization'));
        const threadId = bare('thread', c.req.param('id'));
        await deps.db.asUser(caller.claims, async (tx) => {
          const t = await tx.query<{ state: string }>(`select state from public.threads where id = $1`, [threadId]);
          const cur = t.rows[0]?.state;
          if (!cur) throw new HttpError('NOT_FOUND', 'thread not found');
          const next = action === 'pause' ? 'paused_by_owner' : 'resolved';
          const allowed = action === 'pause' ? cur === 'open' : cur === 'open' || cur === 'paused_by_owner';
          if (cur === next) return;
          if (!allowed) throw new HttpError('CONFLICT', `cannot ${action} a ${cur} thread`);
          await tx.query(`update public.threads set state = $2 where id = $1`, [threadId, next]);
        });
        return c.json(await threadView(deps, caller, threadId));
      } catch (err) { return errorResponse(c, err, deps); }
    });
  }
}
