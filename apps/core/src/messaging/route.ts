/**
 * Message routing (PLAN §9). Runs as the service role, like a worker job:
 * relationship → dmDecision → outbound DLP → L0 screen → state transitions →
 * deliveries, review items and ids-only events. Idempotent: only messages in
 * 'queued' are routed.
 */
import type { Tx } from '@paceline/db';
import { dmDecision, transition, type MessageEvent } from '@paceline/domain';
import { actionFor, dlpScan, l0Scan, normalizeUntrusted, screen } from '@paceline/safety';
import { ulid, type DmPermission, type MessageState, type ScreenAction } from '@paceline/schema';
import type { CoreDeps, PushEvent } from '../contracts.js';
import { HttpError, relationshipBetween, wire, type Relationship } from './util.js';

export interface RouteResult {
  state: MessageState;
  path: 'inbox' | 'wake' | 'owner_notification' | null;
  note: 'will_wake' | 'next_turn' | 'awaiting_human_accept' | 'held_for_your_owner' | 'quarantined' | 'blocked' | 'screening';
  relationship: Relationship | null;
}

interface MsgRow {
  id: string; thread_id: string; sender_kind: 'agent' | 'user' | 'system'; sender_id: string | null;
  sender_owner_id: string | null; body: string; urgency: 'normal' | 'wake'; state: MessageState;
  thread_state: string; thread_kind: string;
}

function step(state: MessageState, event: MessageEvent): MessageState {
  const r = transition(state, event);
  if (!r.ok) throw new HttpError('CONFLICT', `message cannot go ${state} -> ${event.type}`);
  return r.state;
}

async function loadDmPermissions(tx: Tx, recipientOwnerId: string, senderAgentId: string | null, senderOwnerId: string, rel: string): Promise<DmPermission[]> {
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

async function setState(tx: Tx, id: string, state: MessageState, extra: { trust?: string | null; delivered?: boolean } = {}) {
  await tx.query(
    `update public.messages set state = $2, trust = coalesce($3, trust),
            delivered_at = case when $4 then now() else delivered_at end, updated_at = now() where id = $1`,
    [id, state, extra.trust ?? null, extra.delivered ?? false],
  );
}

async function storeVerdict(tx: Tx, messageId: string, outcome: Awaited<ReturnType<typeof screen>>): Promise<string> {
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

async function addReview(tx: Tx, ownerUserId: string, kind: 'dm_request' | 'quarantined_message', refId: string, agentId: string | null, summary: string) {
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
    `select m.id, m.thread_id, m.sender_kind, m.sender_id, m.sender_owner_id, m.body, m.urgency, m.state,
            t.state as thread_state, t.kind as thread_kind
       from public.messages m join public.threads t on t.id = m.thread_id where m.id = $1 for update of m`,
    [messageId],
  );
  const m = r.rows[0];
  if (!m) throw new HttpError('NOT_FOUND', 'message not found');
  if (m.state !== 'queued') return { state: m.state, path: null, note: noteFor(m.state, null), relationship: null };
  const senderOwner = m.sender_owner_id ?? '';
  const isAgent = m.sender_kind === 'agent';

  // Recipients: every agent participant other than the sender.
  const parts = await tx.query<{ p_id: string; owner_user_id: string; wake_on_dm: string | null }>(
    `select p.p_id, p.owner_user_id, s.wake_on_dm from public.thread_participants p
       left join public.agent_settings s on s.agent_id = p.p_id
      where p.thread_id = $1 and p.p_kind = 'agent' and p.p_id is distinct from $2::uuid`,
    [m.thread_id, isAgent ? m.sender_id : null],
  );

  // Outbound DLP on every agent-authored body (I10).
  let state: MessageState = m.state;
  if (isAgent) {
    const crossOwner = parts.rows.some((p) => p.owner_user_id !== senderOwner);
    const dlp = dlpScan(m.body, { allowShortCode: !crossOwner });
    if (!dlp.ok) {
      state = step(state, { type: 'l0_hold' });
      await setState(tx, m.id, state);
      return { state, path: null, note: 'held_for_your_owner', relationship: null };
    }
  }

  // Human comments from the web: screened as `comment`, delivered to every agent participant.
  if (!isAgent) {
    state = step(state, { type: 'submit', permitted: true });
    const out = await screen({ contentClass: 'comment', contentId: wire('message', m.id), text: m.body }, {});
    await storeVerdict(tx, m.id, out);
    state = step(state, { type: 'verdict', action: actionFor('comment', out.screen.label).action });
    await setState(tx, m.id, state, { trust: 'human_comment', delivered: state === 'delivered' });
    if (state === 'delivered') await deliver(tx, deps, m, parts.rows.map((p) => ({ agentId: p.p_id, ownerId: p.owner_user_id, wake: false })), events);
    return { state, path: state === 'delivered' ? 'inbox' : null, note: noteFor(state, 'inbox'), relationship: null };
  }

  // Agent DM: one decision per recipient; v0 DMs have one recipient, so the
  // most restrictive outcome across recipients decides the message state.
  type Rcpt = { agentId: string; ownerId: string; rel: Relationship; decision: ReturnType<typeof dmDecision> };
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
    rcpts.push({ agentId: p.p_id, ownerId: p.owner_user_id, rel, decision });
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
    await setState(tx, m.id, state, { trust: 'stranger' });
    for (const x of rcpts) {
      if (x.decision.outcome !== 'request' && x.decision.outcome !== 'support') continue;
      await addReview(tx, x.ownerId, 'dm_request', wire('message', m.id), x.agentId, 'New DM request from an agent outside your teams');
    }
    return { state, path: 'owner_notification', note: 'awaiting_human_accept', relationship: worst.rel };
  }

  // Permitted: L0 screen (no judge in v0) → actionFor.
  state = step(state, { type: 'submit', permitted: true });
  const contentClass = trust === 'teammate' ? 'dm_teammate' : 'dm_stranger';
  const out = await screen({ contentClass, contentId: wire('message', m.id), text: m.body }, {});
  await storeVerdict(tx, m.id, out);
  const action: ScreenAction = actionFor(contentClass, out.screen.label).action;
  state = step(state, { type: 'verdict', action });
  await setState(tx, m.id, state, { trust, delivered: state === 'delivered' });
  if (state === 'quarantined') {
    for (const x of rcpts) await addReview(tx, x.ownerId, 'quarantined_message', wire('message', m.id), x.agentId, 'A message to your agent was quarantined by screening');
    return { state, path: null, note: 'quarantined', relationship: rel };
  }
  if (state !== 'delivered') return { state, path: null, note: noteFor(state, null), relationship: rel };
  const wake = rcpts.some((x) => x.decision.delivery === 'wake') && !out.decision.noPush;
  await deliver(tx, deps, m, rcpts.map((x) => ({ agentId: x.agentId, ownerId: x.ownerId, wake: x.decision.delivery === 'wake' && !out.decision.noPush })), events);
  if (m.thread_state === 'request' || m.thread_state === 'resolved') {
    await tx.query(`update public.threads set state = 'open', updated_at = now() where id = $1 and state in ('request', 'resolved')`, [m.thread_id]);
  }
  return { state, path: wake ? 'wake' : 'inbox', note: wake ? 'will_wake' : 'next_turn', relationship: rel };
}

async function deliver(
  tx: Tx, _deps: CoreDeps,
  m: Pick<MsgRow, 'id' | 'thread_id' | 'sender_id' | 'thread_state'>,
  rcpts: { agentId: string; ownerId: string; wake: boolean }[],
  events: PushEvent[],
) {
  for (const x of rcpts) {
    await tx.query(
      `insert into public.message_deliveries (message_id, recipient_agent_id, state, path, expires_at)
       values ($1, $2, 'pending', $3, now() + interval '14 days') on conflict do nothing`,
      [m.id, x.agentId, x.wake ? 'wake' : 'inbox'],
    );
  }
  await tx.query(`update public.threads set last_message_at = now() where id = $1`, [m.thread_id]);
  for (const x of rcpts) {
    const payload: Record<string, unknown> = { messageId: wire('message', m.id), threadId: wire('thread', m.thread_id), wake: x.wake };
    if (m.sender_id) payload.senderAgentId = m.sender_id;
    events.push({ type: 'message.new', audienceAgentIds: [x.agentId], audienceUserIds: [x.ownerId], payload });
  }
}

function noteFor(state: MessageState, path: string | null): RouteResult['note'] {
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
 */
export async function applyMessageDecision(deps: CoreDeps, messageWireId: string, decision: 'approve' | 'reject' | 'release'): Promise<MessageState> {
  const id = messageWireId.replace(/^m_/, '');
  const events: PushEvent[] = [];
  const state = await deps.db.asService(async (tx) => {
    const r = await tx.query<MsgRow>(
      `select m.id, m.thread_id, m.sender_kind, m.sender_id, m.sender_owner_id, m.body, m.urgency, m.state,
              t.state as thread_state, t.kind as thread_kind
         from public.messages m join public.threads t on t.id = m.thread_id where m.id = $1 for update of m`, [id]);
    const m = r.rows[0];
    if (!m) throw new HttpError('NOT_FOUND', 'message not found');
    let s: MessageState = m.state;
    const parts = await tx.query<{ p_id: string; owner_user_id: string }>(
      `select p_id, owner_user_id from public.thread_participants where thread_id = $1 and p_kind = 'agent' and p_id is distinct from $2::uuid`,
      [m.thread_id, m.sender_id]);
    const rcpts = parts.rows.map((p) => ({ agentId: p.p_id, ownerId: p.owner_user_id, wake: false }));
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
        await tx.query(`update public.threads set state = 'open', updated_at = now() where id = $1 and state = 'request'`, [m.thread_id]);
        await deliver(tx, deps, m, rcpts, events);
      }
      return s;
    }
    if (s === 'quarantined') {
      s = step(s, { type: 'release' });
      s = step(s, { type: 'deliver' });
      await setState(tx, m.id, s, { delivered: true });
      await deliver(tx, deps, m, rcpts, events);
      return s;
    }
    throw new HttpError('CONFLICT', `message in state ${s} has no pending decision`);
  });
  for (const e of events) await deps.bus.publish(e);
  return state;
}
