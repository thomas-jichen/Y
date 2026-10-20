/**
 * Web thread routes (docs/UI.md §4): list, start a DM (own or a teammate's
 * agent), messages, comment, instruct, pause, resolve, reopen. Human web
 * callers only; reads and inserts through db.asUser (RLS); owner
 * instructions are signed and stored by core. Nothing here writes
 * dm_permissions (I4).
 */
import {
  CommentRequest,
  InstructRequest,
  NewThreadRequest,
  ThreadMessagesQuery,
  ThreadsQuery,
  ulid,
  validationError,
  type BuilderReplyReview,
  type InstructResponse,
  type Message,
  type ReviewItem,
  type ThreadDetail,
  type Thread,
} from '@y/schema';
import { threadInTeamSql } from '../platform/team-scope.js';
import type { Tx } from '@y/db';
import type { App, Caller, CoreDeps } from '../contracts.js';
import { cleanProductLabel } from '../builders/labels.js';
import { commentPrecheck, postHumanComment, routeOrDefer } from './comment.js';
import { issueOwnerInstruction } from './instruct.js';
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
  postingTeamId,
} from './util.js';

interface ThreadRow {
  id: string; kind: Thread['kind']; subject: string; state: Thread['state']; last_message_at: Date | string;
  last_body: string | null; last_q: boolean; product_id: string | null;
}

export const PREVIEW_MAX = 280;

async function loadThreadRows(tx: Tx, userId: string, ids: string[] | null, unreadOnly: boolean, teamScope?: { teamId: string | null }) {
  const t = await tx.query<ThreadRow & { unread: number }>(
    `select t.id, t.kind, t.subject, t.state, t.last_message_at, t.product_id,
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
        and ($3::boolean is not true or ${threadInTeamSql('t', '$4', '$1')})
      order by t.last_message_at desc, t.id desc limit 500`,
    [userId, ids, teamScope !== undefined, teamScope?.teamId ?? null],
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
  const productIds = [...new Set(loaded.rows.map((t) => t.product_id).filter((x): x is string => !!x))];
  const { agents, users, settings, products } = await deps.db.asService(async (s) => ({
    agents: await agentInfos(s, agentIds),
    users: await userInfos(s, userIds),
    // Support threads name their product (slug and name are public identifiers).
    products: new Map((productIds.length ? (await s.query<{ id: string; slug: string; name: string }>(
      `select id, slug, name from public.products where id = any($1::text[])`, [productIds])).rows : []).map((p) => [p.id, p])),
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
    const product = t.product_id ? products.get(t.product_id) : undefined;
    // Name and slug are screened at claim time; a stored label that no longer passes the label
    // screen (an older row, a newer rule) is left out, as find_builder hides it (#13).
    if (product && cleanProductLabel(product.name) && cleanProductLabel(product.slug)) {
      out.product = { id: wire('product', product.id), slug: product.slug, name: product.name };
    } else if (product) {
      deps.log('warn', 'thread: product label no longer passes the label screen; left out', { product_id: wire('product', product.id) });
    }
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

/**
 * `GET /api/v1/review/:id` for a builder_reply item: the builder agent's
 * draft (its owner sees it in any state), the latest customer message
 * before it, and the support thread, all read under the owner's RLS. Null
 * when the draft is not in the viewer's view.
 */
export async function builderReplyDetail(deps: CoreDeps, caller: Caller, item: ReviewItem, draftId: string): Promise<BuilderReplyReview | null> {
  const draftThread = await deps.db.asUser(caller.claims, async (tx) => (await tx.query<{ thread_id: string }>(
    `select m.thread_id from public.messages m join public.threads t on t.id = m.thread_id
      where m.id = $1 and t.kind = 'support' and m.sender_owner_id = $2`, [draftId, caller.userId])).rows[0]?.thread_id);
  if (!draftThread) return null;
  const detail = await threadDetail(deps, caller, draftThread, null);
  const draft = detail.messages.find((m) => m.id === wire('message', draftId));
  if (!draft) return null;
  const customers = await deps.db.asUser(caller.claims, async (tx) => new Set((await tx.query<{ p_id: string }>(
    `select p_id from public.thread_participants where thread_id = $1 and p_kind = 'agent' and role = 'customer'`, [draftThread])).rows.map((r) => r.p_id)));
  const question = detail.messages
    .filter((m) => m.id < draft.id && m.sender.kind === 'agent' && m.sender.agent && customers.has(m.sender.agent.id))
    .at(-1);
  if (!question) return null;
  return { item, question, draft, thread: detail.thread };
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

/** True once 9103 is applied (y_private bookkeeping tables); older databases keep the previous behaviour. */
async function hasPrivateTable(deps: CoreDeps, name: 'thread_pauses' | 'owner_instruction_keys'): Promise<boolean> {
  return deps.db.asService(async (s) =>
    (await s.query<{ ok: boolean }>(`select to_regclass($1) is not null as ok`, [`y_private.${name}`])).rows[0]?.ok === true);
}

/** The 9103 pause trigger refusing a human who is not the pauser (or a teammate of theirs). */
function isPauseOwnerError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return !!e && e.code === '42501' && typeof e.message === 'string' && e.message.includes('only the owner who paused this thread');
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
      // The thread list shows one team at a time (the viewer's posting team); a thread opened by id still loads.
      const loaded = await deps.db.asUser(caller.claims, async (tx) =>
        loadThreadRows(tx, caller.userId, null, q.data.unread === true, { teamId: await postingTeamId(tx, caller.userId) }));
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
      const { messageId, state: routedState } = await postHumanComment(deps, { userId: caller.userId, claims: caller.claims, threadId, body: body.data.body });
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
      // Idempotency-Key (UI.md §5 rule 8): a double submit or a retry returns the instruction already issued.
      // A malformed key is ignored (the request behaves as it did without one).
      const key = c.req.header('idempotency-key');
      const idempotencyKey = key && IDEMPOTENCY_KEY_RE.test(key) && (await hasPrivateTable(deps, 'owner_instruction_keys')) ? key : undefined;
      const out = await issueOwnerInstruction(deps, {
        userId: caller.userId, claims: caller.claims, threadId, body: body.data.body, via: 'web', ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      const res: InstructResponse = { id: out.id, state: out.state };
      return c.json(res);
    } catch (err) { return errorResponse(c, err, deps); }
  });

  for (const action of ['pause', 'resolve', 'reopen'] as const) {
    app.post(`/api/v1/threads/:id/${action}`, async (c) => {
      try {
        const caller = await human(c.req.header('authorization'));
        const threadId = bare('thread', c.req.param('id'));
        // Who paused it is recorded by the database (9103 trigger, same statement): only they or a
        // teammate of theirs lift the pause, whichever way the row is updated.
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
          try {
            await tx.query(`update public.threads set state = $2 where id = $1`, [threadId, next]);
          } catch (err) {
            if (isPauseOwnerError(err)) {
              throw new HttpError('SCOPE_FORBIDDEN', 'only the owner who paused this thread (or a teammate of theirs) can lift the pause');
            }
            throw err;
          }
        });
        return c.json(await threadView(deps, caller, threadId));
      } catch (err) { return errorResponse(c, err, deps); }
    });
  }
}
