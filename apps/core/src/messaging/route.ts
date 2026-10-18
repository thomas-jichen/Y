/**
 * Message routing (PLAN §9). Runs as the service role, like a worker job:
 * relationship → dmDecision → outbound DLP → L0 screen → state transitions →
 * deliveries, review items and ids-only events. Idempotent: only messages in
 * 'queued' are routed.
 */
import type { Tx } from '@y/db';
import { LEASE_STALE_MS, dmDecision, pickLeaseSession, transition, type LeaseCandidate, type MessageEvent } from '@y/domain';
import { actionFor, dlpScan, l0Scan, normalizeUntrusted, screen } from '@y/safety';
import { ulid, type DmPermission, type MessageState, type ScreenAction } from '@y/schema';
import type { CoreDeps, PushEvent } from '../contracts.js';
import { HttpError, relationshipBetween, wire, type Relationship } from './util.js';
import { enqueueMessageNotices } from '../slack/enqueue.js';
import { routeSupportTx, supportDelivered, supportDeliveryFor } from './support.js';
import { DM_REQUEST_BUCKET, dailyCapsEnabled, takeToken } from '../platform/rate-limit.js';

export interface RouteResult {
  state: MessageState;
  path: 'inbox' | 'wake' | 'owner_notification' | null;
  note: 'will_wake' | 'next_turn' | 'awaiting_human_accept' | 'held_for_your_owner' | 'quarantined' | 'blocked' | 'screening';
  relationship: Relationship | 'customer' | null;
}

export interface MsgRow {
  id: string; thread_id: string; sender_kind: 'agent' | 'user' | 'system'; sender_id: string | null;
  sender_owner_id: string | null; body: string; intent: string; urgency: 'normal' | 'wake'; state: MessageState;
  thread_state: string; thread_kind: string; thread_creator: string;
}

export const MSG_SELECT = `select m.id, m.thread_id, m.sender_kind, m.sender_id, m.sender_owner_id, m.body, m.intent, m.urgency, m.state,
            t.state as thread_state, t.kind as thread_kind, t.created_by_user_id as thread_creator
       from public.messages m join public.threads t on t.id = m.thread_id where m.id = $1 for update of m`;

/** request -> open once permission is decided (service role; the DB guard skips it). Also reopens on delivery. */
export async function openThread(tx: Tx, threadId: string, from: readonly string[] = ['request']) {
  await tx.query(`update public.threads set state = 'open', updated_at = now() where id = $1 and state = any($2::text[])`, [threadId, [...from]]);
}

/** True when every recipient owner is the sender's owner or a teammate. */
async function allTrusted(tx: Tx, senderOwner: string, ownerIds: readonly string[]): Promise<boolean> {
  for (const o of new Set(ownerIds)) {
    const rel = await relationshipBetween(tx, senderOwner, o);
    if (rel !== 'self' && rel !== 'teammate') return false;
  }
  return true;
}

/**
 * Copy the sender-written subject to the visible one after the first
 * delivery, only when the L0 screen calls it clean (the body was screened
 * separately). Never overwrites a set subject.
 */
export async function adoptSubject(tx: Tx, threadId: string, contentClass: 'comment' | 'dm_teammate' | 'dm_stranger') {
  const r = await tx.query<{ requested_subject: string; agent_written: boolean; kind: string; cross_owner: boolean }>(
    `select t.requested_subject, t.created_by_agent_id is not null as agent_written, t.kind,
            exists (select 1 from public.thread_participants p
                     where p.thread_id = t.id and p.owner_user_id is distinct from t.created_by_user_id
                       and not exists (select 1 from public.team_members a join public.team_members b on a.team_id = b.team_id
                                        where a.user_id = t.created_by_user_id and b.user_id = p.owner_user_id)) as cross_owner
       from public.threads t where t.id = $1 and t.subject = '' and t.requested_subject <> ''`, [threadId]);
  const raw = r.rows[0]?.requested_subject;
  if (!raw) return;
  const text = normalizeUntrusted(raw).text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 120);
  if (!text || l0Scan(text, contentClass).label !== 'clean') return;
  // An agent-written subject is an agent-authored body too (I10): when it reaches an owner outside
  // the creator's teams (a stranger DM, once accepted) it is egress, and outbound DLP applies
  // strictly. Threads between one owner's agents and teammates' agents adopt subjects as before.
  // Human-written subjects and system-composed support subjects ('Question about <product>') are
  // unchanged.
  const row = r.rows[0]!;
  if (row.agent_written && row.kind !== 'support' && row.cross_owner && !dlpScan(text, { allowShortCode: false }).ok) return;
  await tx.query(`update public.threads set subject = $2 where id = $1 and subject = ''`, [threadId, text]);
}

export function step(state: MessageState, event: MessageEvent): MessageState {
  const r = transition(state, event);
  if (!r.ok) throw new HttpError('CONFLICT', `message cannot go ${state} -> ${event.type}`);
  return r.state;
}

export async function loadDmPermissions(tx: Tx, recipientOwnerId: string, senderAgentId: string | null, senderOwnerId: string, rel: string): Promise<DmPermission[]> {
  // READ ONLY. dm_permissions are written by humans in the web app (I4).
  const r = await tx.query<{ subject_kind: DmPermission['subjectKind']; subject_id: string; policy: DmPermission['policy']; delivery: DmPermission['delivery'] }>(
    `select subject_kind, subject_id, policy, delivery from public.dm_permissions
      where owner_user_id = $1
        and ((subject_kind = 'agent' and subject_id = $2) or (subject_kind = 'user' and subject_id = $3)
             or (subject_kind = 'relationship' and subject_id = $4))
      order by case subject_kind when 'agent' then 0 when 'user' then 1 when 'team' then 2 when 'product' then 3 else 4 end`,
    [recipientOwnerId, senderAgentId ?? '', senderOwnerId, rel],
  );
  return r.rows.map((x) => ({ subjectKind: x.subject_kind, subjectId: x.subject_id, policy: x.policy, delivery: x.delivery }));
}

async function senderGithubAgeOk(tx: Tx, userId: string, now: Date): Promise<boolean> {
  const r = await tx.query<{ github_created_at: Date | string | null }>(
    `select github_created_at from public.user_private where user_id = $1`, [userId]);
  const v = r.rows[0]?.github_created_at;
  // Unknown age only ever reaches the human-gated request flow, never delivery.
  if (v === null || v === undefined) return true;
  return now.getTime() - new Date(v).getTime() >= 30 * 24 * 3600 * 1000;
}

export async function setState(tx: Tx, id: string, state: MessageState, extra: { trust?: string | null; delivered?: boolean } = {}) {
  await tx.query(
    `update public.messages set state = $2, trust = coalesce($3, trust),
            delivered_at = case when $4 then now() else delivered_at end, updated_at = now() where id = $1`,
    [id, state, extra.trust ?? null, extra.delivered ?? false],
  );
}

export async function storeVerdict(tx: Tx, messageId: string, outcome: Awaited<ReturnType<typeof screen>>): Promise<string> {
  const id = ulid();
  const v = outcome.verdict;
  await tx.query(
    `insert into public.verdicts (id, content_class, content_id, l0, l2, label, action, decision, layers, latency_ms, cost_usd)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9::text[], $10, $11)`,
    [id, v.contentClass, wire('message', messageId), JSON.stringify(v.l0), v.l2 ? JSON.stringify(v.l2) : null,
     v.label, outcome.decision.action, JSON.stringify(outcome.decision), outcome.screen.layers.length ? outcome.screen.layers : ['l0'],
     Math.max(0, Math.round(v.latencyMs ?? 0)), v.costUsd ?? 0],
  );
  await tx.query(
    `update public.messages set screen_label = $2, screen_layers = $3::text[], screen_action = $4, verdict_id = $5 where id = $1`,
    [messageId, outcome.screen.label, outcome.screen.layers.length ? outcome.screen.layers : ['l0'], outcome.decision.action, id],
  );
  return id;
}

export async function addReview(tx: Tx, ownerUserId: string, kind: 'dm_request' | 'quarantined_message' | 'builder_reply', refId: string, agentId: string | null, summary: string) {
  // The review_items insert trigger emits review.new (ids only).
  await tx.query(
    `insert into public.review_items (owner_user_id, kind, ref_id, agent_id, summary, expires_at)
     values ($1, $2, $3, $4, $5, now() + interval '14 days')
     on conflict do nothing`,
    [ownerUserId, kind, refId, agentId, summary],
  );
}

/**
 * Route one queued message. Returns the resulting state and delivery path.
 * Events to publish are returned (published by the caller after commit).
 */
export async function routeMessageTx(tx: Tx, deps: CoreDeps, messageId: string, events: PushEvent[]): Promise<RouteResult> {
  const r = await tx.query<MsgRow>(
    MSG_SELECT,
    [messageId],
  );
  const m = r.rows[0];
  if (!m) throw new HttpError('NOT_FOUND', 'message not found');
  if (m.state !== 'queued') return { state: m.state, path: null, note: noteFor(m.state, null), relationship: null };
  const senderOwner = m.sender_owner_id ?? '';
  const isAgent = m.sender_kind === 'agent';

  // Recipients: every agent participant other than the sender.
  const parts = await tx.query<{ p_id: string; owner_user_id: string; wake_on_dm: string | null; muted: boolean }>(
    `select p.p_id, p.owner_user_id, s.wake_on_dm, coalesce(p.muted, false) as muted from public.thread_participants p
       left join public.agent_settings s on s.agent_id = p.p_id
      where p.thread_id = $1 and p.p_kind = 'agent' and p.p_id is distinct from $2::uuid`,
    [m.thread_id, isAgent ? m.sender_id : null],
  );

  // Human participants (a DM a human started, team rooms): they read in the web app.
  const humans = await tx.query<{ owner_user_id: string }>(
    `select owner_user_id from public.thread_participants where thread_id = $1 and p_kind = 'user'`, [m.thread_id]);

  // Archived is a human decision (only humans may set it, and the DB guard
  // never lets it go back): agents cannot write into or reopen it (I11).
  let state: MessageState = m.state;
  if (isAgent && m.thread_state === 'archived') {
    state = step(state, { type: 'submit', permitted: false });
    state = step(state, { type: 'request_declined' });
    await setState(tx, m.id, state);
    return { state, path: null, note: 'blocked', relationship: null };
  }

  // Outbound DLP on every agent-authored body (I10).
  if (isAgent) {
    // Support threads are customer <-> builder egress: always strict, even between one owner's agents.
    const crossOwner = m.thread_kind === 'support'
      || parts.rows.some((p) => p.owner_user_id !== senderOwner) || humans.rows.some((h) => h.owner_user_id !== senderOwner);
    const dlp = dlpScan(m.body, { allowShortCode: !crossOwner });
    if (!dlp.ok) {
      state = step(state, { type: 'l0_hold' });
      await setState(tx, m.id, state);
      // A held first message must not leave a teammate thread stuck in 'request'.
      if (m.thread_state === 'request' && await allTrusted(tx, senderOwner, parts.rows.map((p) => p.owner_user_id))) await openThread(tx, m.thread_id);
      return { state, path: null, note: 'held_for_your_owner', relationship: null };
    }
  }

  // Support threads (customer <-> builder agent), human comments included: their own routing (support.ts).
  if (m.thread_kind === 'support') return routeSupportTx(tx, deps, m, parts.rows, events);

  // Human comments from the web: screened as `comment`, delivered to every agent participant.
  // Never on an archived thread, and on a 'request' thread only for the human
  // who started it with their own or a teammate's agent (POST /threads); a
  // stranger intro stays closed until the recipient's human accepts (I4).
  if (!isAgent) {
    const startedHere = m.thread_state === 'request' && m.thread_creator === senderOwner
      && await allTrusted(tx, senderOwner, parts.rows.map((p) => p.owner_user_id));
    if (m.thread_state === 'archived' || (m.thread_state === 'request' && !startedHere)) {
      state = step(state, { type: 'submit', permitted: false });
      state = step(state, { type: 'request_declined' });
      await setState(tx, m.id, state, { trust: 'human_comment' });
      return { state, path: null, note: 'blocked', relationship: null };
    }
    if (startedHere) await openThread(tx, m.thread_id);
    state = step(state, { type: 'submit', permitted: true });
    const out = await screen({ contentClass: 'comment', contentId: wire('message', m.id), text: m.body }, {});
    await storeVerdict(tx, m.id, out);
    state = step(state, { type: 'verdict', action: actionFor('comment', out.screen.label).action });
    await setState(tx, m.id, state, { trust: 'human_comment', delivered: state === 'delivered' });
    if (state === 'delivered') {
      await deliver(tx, deps, m, parts.rows.map((p) => ({ agentId: p.p_id, ownerId: p.owner_user_id, wake: false })), events);
      await adoptSubject(tx, m.thread_id, 'comment');
    }
    return { state, path: state === 'delivered' ? 'inbox' : null, note: noteFor(state, 'inbox'), relationship: null };
  }

  // An agent replying in a DM a human started: no agent recipients, only
  // humans, who must be the sender's owner or teammates. Screened as a
  // teammate DM; nothing is pushed to any agent.
  if (parts.rows.length === 0 && humans.rows.length > 0) {
    if (!(await allTrusted(tx, senderOwner, humans.rows.map((h) => h.owner_user_id)))) {
      state = step(state, { type: 'submit', permitted: false });
      state = step(state, { type: 'request_declined' });
      await setState(tx, m.id, state, { trust: 'stranger' });
      return { state, path: null, note: 'blocked', relationship: 'stranger' };
    }
    const rel: Relationship = humans.rows.every((h) => h.owner_user_id === senderOwner) ? 'self' : 'teammate';
    state = step(state, { type: 'submit', permitted: true });
    if (m.thread_state === 'request') await openThread(tx, m.thread_id);
    const out = await screen({ contentClass: 'dm_teammate', contentId: wire('message', m.id), text: m.body }, {});
    await storeVerdict(tx, m.id, out);
    state = step(state, { type: 'verdict', action: actionFor('dm_teammate', out.screen.label).action });
    await setState(tx, m.id, state, { trust: 'teammate', delivered: state === 'delivered' });
    const owners = [...new Set([...humans.rows.map((h) => h.owner_user_id), senderOwner])].filter(Boolean);
    if (state === 'quarantined') {
      for (const o of new Set(humans.rows.map((h) => h.owner_user_id))) {
        await addReview(tx, o, 'quarantined_message', wire('message', m.id), null, 'A message in your thread was quarantined by screening');
      }
      return { state, path: null, note: 'quarantined', relationship: rel };
    }
    if (state !== 'delivered') return { state, path: null, note: noteFor(state, null), relationship: rel };
    await tx.query(`update public.threads set last_message_at = now() where id = $1`, [m.thread_id]);
    if (m.thread_state === 'resolved') await openThread(tx, m.thread_id, ['resolved']);
    const payload: Record<string, unknown> = { messageId: wire('message', m.id), threadId: wire('thread', m.thread_id), wake: false };
    if (m.sender_id) payload.senderAgentId = m.sender_id;
    events.push({ type: 'message.new', audienceAgentIds: [], audienceUserIds: owners, payload });
    await enqueueMessageNotices(tx, deps, {
      messageId: m.id, threadId: m.thread_id, threadKind: m.thread_kind, senderKind: m.sender_kind,
      senderId: m.sender_id, senderOwnerId: m.sender_owner_id, recipientOwnerIds: [],
    });
    return { state, path: 'inbox', note: 'next_turn', relationship: rel };
  }

  // Agent DM: one decision per recipient; v0 DMs have one recipient, so the
  // most restrictive outcome across recipients decides the message state.
  type Rcpt = { agentId: string; ownerId: string; rel: Relationship; decision: ReturnType<typeof dmDecision>; muted: boolean };
  const rcpts: Rcpt[] = [];
  for (const p of parts.rows) {
    const rel = await relationshipBetween(tx, senderOwner, p.owner_user_id);
    const explicit = await loadDmPermissions(tx, p.owner_user_id, m.sender_id, senderOwner, rel);
    const decision = dmDecision(rel, {
      explicit,
      urgency: m.urgency,
      recipientWakeOnDm: (p.wake_on_dm ?? 'teammates') as 'teammates',
      senderGithubAgeOk: rel === 'stranger' ? await senderGithubAgeOk(tx, senderOwner, deps.now()) : true,
    });
    rcpts.push({ agentId: p.p_id, ownerId: p.owner_user_id, rel, decision, muted: p.muted === true });
  }
  if (rcpts.length === 0) throw new HttpError('VALIDATION', 'thread has no recipient agents');

  const worst = rcpts.find((x) => x.decision.outcome === 'deny')
    ?? rcpts.find((x) => x.decision.outcome === 'request' || x.decision.outcome === 'support');
  const rel = rcpts[0]!.rel;
  const trust = rel === 'self' || rel === 'teammate' ? 'teammate' : 'stranger';

  if (worst && worst.decision.outcome === 'deny') {
    state = step(state, { type: 'submit', permitted: false });
    state = step(state, { type: 'request_declined' });
    await setState(tx, m.id, state, { trust });
    return { state, path: null, note: 'blocked', relationship: worst.rel };
  }

  if (worst) {
    // Stranger intro: the recipient's HUMAN gets a review item; the recipient agent sees nothing (I4).
    state = step(state, { type: 'submit', permitted: false });
    const norm = normalizeUntrusted(m.body).text;
    const l0 = l0Scan(norm, 'dm_stranger');
    if (l0.label === 'malicious') {
      state = step(state, { type: 'verdict', action: 'block' });
      await setState(tx, m.id, state, { trust: 'stranger' });
      return { state, path: null, note: 'blocked', relationship: worst.rel };
    }
    // DM requests file a review item for another human: 5 / day per sender owner (PLAN §10).
    // A refusal rolls this routing back; send_message withdraws the queued message and refuses.
    if (dailyCapsEnabled() && rcpts.some((x) => x.decision.outcome === 'request')) {
      const rl = await takeToken(tx, 'dm_requests', [senderOwner], DM_REQUEST_BUCKET);
      if (!rl.allowed) {
        throw new HttpError('RATE_LIMITED', `DM requests to agents outside your teams are limited to ${DM_REQUEST_BUCKET.burst} per day`, { retryAfterS: rl.retryAfterS });
      }
    }
    await setState(tx, m.id, state, { trust: 'stranger' });
    for (const x of rcpts) {
      if (x.decision.outcome !== 'request' && x.decision.outcome !== 'support') continue;
      await addReview(tx, x.ownerId, 'dm_request', wire('message', m.id), x.agentId, 'New DM request from an agent outside your teams');
    }
    return { state, path: 'owner_notification', note: 'awaiting_human_accept', relationship: worst.rel };
  }

  // Permitted: L0 screen (no judge in v0) → actionFor. Permission is decided,
  // so the thread opens now, whatever the screen says (a quarantined first
  // message must not leave a teammate thread stuck in 'request').
  state = step(state, { type: 'submit', permitted: true });
  if (m.thread_state === 'request') await openThread(tx, m.thread_id);
  const contentClass = trust === 'teammate' ? 'dm_teammate' : 'dm_stranger';
  const out = await screen({ contentClass, contentId: wire('message', m.id), text: m.body }, {});
  await storeVerdict(tx, m.id, out);
  let action: ScreenAction = actionFor(contentClass, out.screen.label).action;
  // Only a human's explicit allow row puts a stranger on this path (the default is the request
  // flow above): the human already decided, so a clean screen delivers instead of waiting for
  // an accept nobody is asked for. Warn/suspicious/malicious keep their actions.
  if (action === 'request_flow') action = 'allow';
  state = step(state, { type: 'verdict', action });
  await setState(tx, m.id, state, { trust, delivered: state === 'delivered' });
  if (state === 'quarantined') {
    for (const x of rcpts) await addReview(tx, x.ownerId, 'quarantined_message', wire('message', m.id), x.agentId, 'A message to your agent was quarantined by screening');
    return { state, path: null, note: 'quarantined', relationship: rel };
  }
  if (state !== 'delivered') return { state, path: null, note: noteFor(state, null), relationship: rel };
  // A recipient that muted the thread (update_thread mute) still gets it in its inbox, never as a wake.
  const wakes = (x: Rcpt) => x.decision.delivery === 'wake' && !out.decision.noPush && !x.muted;
  const wake = rcpts.some(wakes);
  await deliver(tx, deps, m, rcpts.map((x) => ({ agentId: x.agentId, ownerId: x.ownerId, wake: wakes(x) })), events);
  if (m.thread_state === 'resolved') await openThread(tx, m.thread_id, ['resolved']);
  await adoptSubject(tx, m.thread_id, contentClass);
  return { state, path: wake ? 'wake' : 'inbox', note: wake ? 'will_wake' : 'next_turn', relationship: rel };
}

export async function deliver(
  tx: Tx, _deps: CoreDeps,
  m: Pick<MsgRow, 'id' | 'thread_id' | 'sender_kind' | 'sender_id' | 'sender_owner_id' | 'thread_state' | 'thread_kind'>,
  rcpts: { agentId: string; ownerId: string; wake: boolean }[],
  events: PushEvent[],
) {
  for (const x of rcpts) {
    // A wake targets exactly ONE listening session, chosen now (PLAN §9 leases).
    const target = x.wake ? await pickTarget(tx, x.agentId, m.thread_id, _deps.now().getTime()) : null;
    await tx.query(
      `insert into public.message_deliveries (message_id, recipient_agent_id, state, path, target_session_id, expires_at)
       values ($1, $2, 'pending', $3, $4, now() + interval '14 days') on conflict do nothing`,
      [m.id, x.agentId, x.wake ? 'wake' : 'inbox', target],
    );
  }
  await tx.query(`update public.threads set last_message_at = now() where id = $1`, [m.thread_id]);
  for (const x of rcpts) {
    const payload: Record<string, unknown> = { messageId: wire('message', m.id), threadId: wire('thread', m.thread_id), wake: x.wake };
    if (m.sender_id) payload.senderAgentId = m.sender_id;
    // The sender's human sees the thread update live too (ids only).
    const users = m.sender_owner_id && m.sender_owner_id !== x.ownerId ? [x.ownerId, m.sender_owner_id] : [x.ownerId];
    events.push({ type: 'message.new', audienceAgentIds: [x.agentId], audienceUserIds: users, payload });
  }
  // Human participants not covered above (a member without an agent in a team room).
  const covered = new Set(rcpts.map((x) => x.ownerId));
  if (m.sender_owner_id) covered.add(m.sender_owner_id);
  const humans = await tx.query<{ owner_user_id: string }>(
    `select owner_user_id from public.thread_participants where thread_id = $1 and p_kind = 'user'`, [m.thread_id]);
  const rest = [...new Set(humans.rows.map((h) => h.owner_user_id))].filter((u) => !covered.has(u));
  if (rest.length) {
    const payload: Record<string, unknown> = { messageId: wire('message', m.id), threadId: wire('thread', m.thread_id), wake: false };
    if (m.sender_id) payload.senderAgentId = m.sender_id;
    events.push({ type: 'message.new', audienceAgentIds: [], audienceUserIds: rest, payload });
  }
  // Slack notices for linked owners (ids-only jobs in this transaction; no-op when Slack is off).
  await enqueueMessageNotices(tx, _deps, {
    messageId: m.id, threadId: m.thread_id, threadKind: m.thread_kind, senderKind: m.sender_kind,
    senderId: m.sender_id, senderOwnerId: m.sender_owner_id, recipientOwnerIds: rcpts.map((x) => x.ownerId),
  });
}

export async function pickTarget(tx: Tx, agentId: string, threadId: string, now: number): Promise<string | null> {
  const r = await tx.query<{ session_id: string; listening: string; last_heartbeat_at: Date | string; repo_key: string | null;
    last_thread_ids: string[]; permission_mode: string; headless: boolean }>(
    `select session_id, listening, last_heartbeat_at, repo_key, last_thread_ids, permission_mode, headless
       from public.session_leases where agent_id = $1 and last_heartbeat_at > now() - ($2::int * interval '1 millisecond')`,
    [agentId, LEASE_STALE_MS]);
  const cands: LeaseCandidate[] = r.rows.map((l) => {
    const c: LeaseCandidate = {
      sessionId: l.session_id, listening: l.listening !== 'none', needsApproval: l.listening === 'listening_needs_approval',
      lastHeartbeatAt: new Date(l.last_heartbeat_at).getTime(), lastThreadIds: l.last_thread_ids ?? [],
      permissionMode: l.permission_mode as LeaseCandidate['permissionMode'], headless: l.headless,
    };
    if (l.repo_key) c.repoKey = l.repo_key;
    return c;
  });
  return pickLeaseSession(cands, { now, kind: 'dm', threadId });
}

export function noteFor(state: MessageState, path: string | null): RouteResult['note'] {
  switch (state) {
    case 'delivered':
    case 'released': return path === 'wake' ? 'will_wake' : 'next_turn';
    case 'request_pending': return 'awaiting_human_accept';
    case 'held_for_sender': return 'held_for_your_owner';
    case 'quarantined': return 'quarantined';
    case 'blocked':
    case 'rejected':
    case 'expired': return 'blocked';
    default: return 'screening';
  }
}

/**
 * The route_message job's answer to a daily-cap refusal (DM requests, PLAN §10). Inline
 * send_message withdraws the message and refuses the send; a deferred message was already
 * accepted as 'queued', so retrying until the job dies would leave it queued for good. It is
 * blocked instead, as a malicious stranger intro is (queued -> request_pending -> blocked):
 * the sender sees a terminal state and no review item is filed.
 */
export async function blockCappedMessage(deps: CoreDeps, messageId: string): Promise<MessageState | null> {
  return deps.db.asService(async (tx) => {
    const r = await tx.query<{ state: MessageState }>('select state from public.messages where id = $1 for update', [messageId]);
    const cur = r.rows[0]?.state;
    if (cur !== 'queued') return cur ?? null;
    let state = step(cur, { type: 'submit', permitted: false });
    state = step(state, { type: 'verdict', action: 'block' });
    await setState(tx, messageId, state, { trust: 'stranger' });
    return state;
  });
}

/** Route in its own service transaction and publish the resulting events. */
export async function routeMessage(deps: CoreDeps, messageId: string): Promise<RouteResult> {
  const events: PushEvent[] = [];
  const res = await deps.db.asService((tx) => routeMessageTx(tx, deps, messageId, events));
  for (const e of events) await deps.bus.publish(e);
  return res;
}

/**
 * Human decision on a dm_request or quarantined_message review item (called
 * by the platform review-decision route; the human gesture is checked there).
 *
 * A quarantined message can have several recipient owners (a team room): each
 * owner's review item decides delivery to that owner's agents only. With
 * `reviewId`, a release delivers to the deciding owner's agents, and a reject
 * leaves the message quarantined while other owners' items are still pending.
 * Without it (legacy jobs), the decision applies to every recipient.
 */
export async function applyMessageDecision(
  deps: CoreDeps, messageWireId: string, decision: 'approve' | 'reject' | 'release', reviewId?: string,
): Promise<MessageState> {
  const id = messageWireId.replace(/^m_/, '');
  const events: PushEvent[] = [];
  const state = await deps.db.asService(async (tx) => {
    const r = await tx.query<MsgRow>(
      MSG_SELECT, [id]);
    const m = r.rows[0];
    if (!m) throw new HttpError('NOT_FOUND', 'message not found');
    let s: MessageState = m.state;
    const parts = await tx.query<{ p_id: string; owner_user_id: string }>(
      `select p_id, owner_user_id from public.thread_participants where thread_id = $1 and p_kind = 'agent' and p_id is distinct from $2::uuid`,
      [m.thread_id, m.sender_id]);
    let rcpts = parts.rows.map((p) => ({ agentId: p.p_id, ownerId: p.owner_user_id, wake: false }));
    // Support threads: role-based recipients; nothing goes out once the product is suspended or the builder replaced.
    const sd = m.thread_kind === 'support' ? await supportDeliveryFor(tx, m) : null;
    if (m.thread_kind === 'support') {
      if (!sd) {
        if (s === 'request_pending') s = step(s, { type: 'request_declined' });
        else if (s === 'quarantined') s = step(s, { type: 'reject' });
        else throw new HttpError('CONFLICT', `message in state ${s} has no pending decision`);
        await setState(tx, m.id, s);
        return s;
      }
      rcpts = sd.rcpts.map((p) => ({ agentId: p.p_id, ownerId: p.owner_user_id, wake: false }));
    }

    // The deciding owner (quarantined_message only; a dm_request has one recipient).
    let decider: string | null = null;
    if (reviewId) {
      const rv = await tx.query<{ owner_user_id: string; kind: string }>(
        `select owner_user_id, kind from public.review_items where id = $1 and ref_id = $2`, [reviewId, wire('message', m.id)]);
      const row = rv.rows[0];
      if (!row) throw new HttpError('NOT_FOUND', 'review item not found for this message');
      if (row.kind === 'quarantined_message') decider = row.owner_user_id;
    }
    if (decider) {
      rcpts = rcpts.filter((x) => x.ownerId === decider);
      // Other owners still deciding, or who already released (their job may not have run yet):
      // a reject must not discard their decision about their own agents (order-independent).
      const pendingOthers = await tx.query<{ n: number }>(
        `select count(*)::int as n from public.review_items
          where ref_id = $1 and kind = 'quarantined_message' and owner_user_id <> $2
            and (state = 'pending' or (state = 'approved' and decision is distinct from 'reject'))`,
        [wire('message', m.id), decider]);
      const othersPending = (pendingOthers.rows[0]?.n ?? 0) > 0;
      if (decision === 'reject') {
        // Another owner may still release to their own agents.
        if (s === 'quarantined' && !othersPending) {
          s = step(s, { type: 'reject' });
          await setState(tx, m.id, s);
        }
        return s;
      }
      if (decision === 'release' && s !== 'quarantined') {
        // Another owner released it first: deliver to this owner's agents too.
        if (s !== 'delivered' && s !== 'released') throw new HttpError('CONFLICT', `message in state ${s} has no pending decision`);
        await deliver(tx, deps, m, rcpts, events);
        return s;
      }
    }
    if (decision === 'reject') {
      s = step(s, s === 'request_pending' ? { type: 'request_declined' } : { type: 'reject' });
      await setState(tx, m.id, s);
      return s;
    }
    if (s === 'request_pending') {
      s = step(s, { type: 'request_accepted' });
      const out = await screen({ contentClass: 'dm_stranger', contentId: wire('message', m.id), text: m.body }, {});
      await storeVerdict(tx, m.id, out);
      // The human accepted after seeing the intro: anything short of malicious is delivered with its label.
      const action: ScreenAction = out.screen.label === 'malicious' ? 'block' : out.screen.label === 'clean' ? 'allow' : 'label';
      s = step(s, { type: 'verdict', action });
      await setState(tx, m.id, s, { delivered: s === 'delivered' });
      if (s === 'delivered') {
        if (sd) await supportDelivered(tx, sd, m);
        await openThread(tx, m.thread_id);
        await deliver(tx, deps, m, rcpts, events);
        await adoptSubject(tx, m.thread_id, 'dm_stranger');
      }
      return s;
    }
    if (s === 'quarantined') {
      s = step(s, { type: 'release' });
      s = step(s, { type: 'deliver' });
      await setState(tx, m.id, s, { delivered: true });
      // A released first message opens its thread, or the recipient agent never sees it (threads_select).
      if (sd) await supportDelivered(tx, sd, m);
      await openThread(tx, m.thread_id);
      await deliver(tx, deps, m, rcpts, events);
      return s;
    }
    throw new HttpError('CONFLICT', `message in state ${s} has no pending decision`);
  });
  for (const e of events) await deps.bus.publish(e);
  return state;
}
