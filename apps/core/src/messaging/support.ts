/**
 * Support threads (PLAN §6 "Customer → builder"): a customer's agent asks a
 * product's builder agent (ask_builder, then send_message follow-ups), and
 * the builder's replies wait in the builder approval queue.
 *
 * - Customer → builder: relationship `customer` (unless the two owners share
 *   a team), screened as `dm_stranger` (L0), delivered to the builder agent's
 *   inbox only: customer content never wakes it. Quarantine goes to the
 *   builder's human (quarantined_message); `bug_report` makes a builder_task.
 * - Builder → customer: with `reply_policy` `builder_approves` the draft goes
 *   `request_pending` and the builder agent's OWNER gets a `builder_reply`
 *   review item; nothing reaches the customer until that human approves
 *   (I5). `auto_send` screens as `builder_answer` and delivers (inbox).
 * - Who is the builder comes from `products.builder_agent_id`, never from a
 *   participant row alone: a replaced builder is removed from the product's
 *   threads and nothing it sends is routed.
 * - Human comments take the same paths: a customer's human is screened like
 *   a customer agent; the builder's human answers directly (their gesture).
 *
 * Runs as the service role inside route.ts's transaction. Outbound DLP was
 * already applied there (strict for every support thread, I10).
 */
import type { Tx } from '@y/db';
import { dmDecision } from '@y/domain';
import { actionFor, dlpScan, l0Scan, normalizeUntrusted, screen } from '@y/safety';
import { CROSS_OWNER_BODY_MAX, type MessageState, type ScreenAction } from '@y/schema';
import type { CoreDeps, PushEvent } from '../contracts.js';
import {
  MSG_SELECT,
  addReview,
  adoptSubject,
  deliver,
  loadDmPermissions,
  noteFor,
  openThread,
  setState,
  step,
  storeVerdict,
  type MsgRow,
  type RouteResult,
} from './route.js';
import { HttpError, relationshipBetween, wire, type Relationship } from './util.js';

export const BUILDER_REPLY_SUMMARY = 'Your agent drafted a reply to a customer';

interface SupportCtx {
  productId: string;
  teamId: string;
  status: string;
  replyPolicy: 'builder_approves' | 'auto_send';
  /**
   * products.builder_agent_id and its owner: the ONLY agent (and human) that
   * speaks for the product. A former builder's participant row grants nothing.
   */
  builderId: string | null;
  builderOwner: string | null;
  /** Agent participant → role (`builder` | `customer` | …). */
  roles: Map<string, string>;
}

type LiveCtx = SupportCtx & { builderId: string; builderOwner: string };
type Side = 'builder' | 'customer';
type Part = { p_id: string; owner_user_id: string };

async function supportContext(tx: Tx, threadId: string): Promise<SupportCtx | null> {
  const p = await tx.query<{ id: string; owner_team_id: string; status: string; reply_policy: SupportCtx['replyPolicy']; builder_agent_id: string | null; builder_owner: string | null }>(
    `select p.id, p.owner_team_id, p.status, p.reply_policy, p.builder_agent_id, a.owner_user_id as builder_owner
       from public.threads t join public.products p on p.id = t.product_id
       left join public.agents a on a.id = p.builder_agent_id and a.status = 'active'
      where t.id = $1 and t.kind = 'support'`, [threadId]);
  const row = p.rows[0];
  if (!row) return null;
  const parts = await tx.query<{ p_id: string; role: string }>(
    `select p_id, role from public.thread_participants where thread_id = $1 and p_kind = 'agent'`, [threadId]);
  return {
    productId: row.id, teamId: row.owner_team_id, status: row.status, replyPolicy: row.reply_policy,
    builderId: row.builder_owner ? row.builder_agent_id : null, builderOwner: row.builder_owner,
    roles: new Map(parts.rows.map((x) => [x.p_id, x.role])),
  };
}

/** Active, with a (live) builder agent: otherwise the product takes no messages either way. */
function live(ctx: SupportCtx | null): ctx is LiveCtx {
  return !!ctx && ctx.status === 'active' && !!ctx.builderId && !!ctx.builderOwner;
}

/**
 * Which side a message comes from. Builder: the product's CURRENT builder
 * agent, or its owner commenting as a human. Customer: an agent participant
 * with role `customer`, or a human who owns one. Anyone else (a replaced
 * builder, an observer): null, and nothing is routed.
 */
function sideOf(ctx: LiveCtx, m: Pick<MsgRow, 'sender_kind' | 'sender_id' | 'sender_owner_id'>, parts: readonly Part[]): Side | null {
  if (m.sender_kind === 'agent') {
    if (!m.sender_id) return null;
    if (m.sender_id === ctx.builderId) return 'builder';
    return ctx.roles.get(m.sender_id) === 'customer' ? 'customer' : null;
  }
  if (m.sender_kind !== 'user' || !m.sender_owner_id) return null;
  if (m.sender_owner_id === ctx.builderOwner) return 'builder';
  return parts.some((p) => ctx.roles.get(p.p_id) === 'customer' && p.owner_user_id === m.sender_owner_id) ? 'customer' : null;
}

/** Customer agents of the thread (never the builder itself). */
function customerParts(ctx: LiveCtx, parts: readonly Part[]): Part[] {
  return parts.filter((p) => ctx.roles.get(p.p_id) === 'customer' && p.p_id !== ctx.builderId);
}

/**
 * Make the product's current builder agent the only `builder` participant of
 * its support threads (one thread, or all of them): a replaced builder leaves
 * (it no longer reads customer content, I4), the new one joins. Service role.
 */
export async function syncSupportBuilders(tx: Tx, productId: string, threadId: string | null = null) {
  await tx.query(
    `delete from public.thread_participants tp using public.threads t, public.products p
      where tp.thread_id = t.id and t.product_id = p.id and p.id = $1 and t.kind = 'support'
        and ($2::text is null or t.id = $2) and tp.p_kind = 'agent' and tp.role = 'builder'
        and tp.p_id is distinct from p.builder_agent_id`, [productId, threadId]);
  await tx.query(
    `insert into public.thread_participants (thread_id, p_kind, p_id, role)
     select t.id, 'agent', p.builder_agent_id, 'builder' from public.threads t join public.products p on p.id = t.product_id
      where p.id = $1 and t.kind = 'support' and ($2::text is null or t.id = $2)
        and p.builder_agent_id is not null and t.state <> 'archived'
     on conflict do nothing`, [productId, threadId]);
}

/** 'self' when every recipient is the sender's owner, 'teammate' when all share a team with them, else null. */
async function trustedRel(tx: Tx, senderOwner: string, ownerIds: readonly string[]): Promise<Relationship | null> {
  let all: Relationship = 'self';
  for (const o of new Set(ownerIds)) {
    const rel = await relationshipBetween(tx, senderOwner, o);
    if (rel === 'stranger') return null;
    if (rel === 'teammate') all = 'teammate';
  }
  return all;
}

/** The first delivery opens the support thread (created as 'request' by the customer) under the product's team. */
async function openSupportThread(tx: Tx, threadId: string, teamId: string) {
  await tx.query(
    `update public.threads set state = 'open', team_id = coalesce(team_id, $2), updated_at = now() where id = $1 and state = 'request'`,
    [threadId, teamId]);
}

/** A customer-side `bug_report`, once delivered, becomes one builder_task (inline, released or accepted). */
async function recordBugReport(tx: Tx, productId: string, m: Pick<MsgRow, 'id' | 'thread_id' | 'intent'>) {
  if (m.intent !== 'bug_report') return;
  await tx.query(
    `insert into public.builder_tasks (product_id, thread_id, source_message_id) values ($1, $2, $3)
     on conflict (source_message_id) where source_message_id is not null do nothing`,
    [productId, m.thread_id, m.id]);
}

/** Route one queued agent message, or human comment, in a support thread (called by routeMessageTx). */
export async function routeSupportTx(tx: Tx, deps: CoreDeps, m: MsgRow, parts: readonly Part[], events: PushEvent[]): Promise<RouteResult> {
  let state: MessageState = m.state;
  const senderOwner = m.sender_owner_id ?? '';
  const human = m.sender_kind === 'user';
  const ctx = await supportContext(tx, m.thread_id);
  const blocked = async (trust: string | null = null): Promise<RouteResult> => {
    state = step(state, { type: 'submit', permitted: false });
    state = step(state, { type: 'request_declined' });
    await setState(tx, m.id, state, { trust: human ? 'human_comment' : trust });
    return { state, path: null, note: 'blocked', relationship: null };
  };
  // A suspended product (or one without a builder agent) takes no new messages either way,
  // and only its current builder speaks for it. Archived is terminal for humans too.
  if (m.thread_state === 'archived' || !live(ctx)) return blocked();
  const side = sideOf(ctx, m, parts);
  if (!side) return blocked();

  if (side === 'customer') {
    // Customer content reaches the product's current builder agent only.
    await syncSupportBuilders(tx, ctx.productId, m.thread_id);
    const rcpts: Part[] = [{ p_id: ctx.builderId, owner_user_id: ctx.builderOwner }];
    const mate = await trustedRel(tx, senderOwner, rcpts.map((p) => p.owner_user_id));
    const rel = mate ?? 'customer';
    const trust = human ? 'human_comment' : mate ? 'teammate' : 'customer';
    // Human-written dm_permissions still apply (READ ONLY, I4). Customers never wake.
    let gated = false;
    for (const p of rcpts) {
      const explicit = await loadDmPermissions(tx, p.owner_user_id, m.sender_id, senderOwner, rel);
      const d = dmDecision(rel, { explicit, urgency: 'normal', recipientWakeOnDm: 'off', senderGithubAgeOk: true });
      if (d.outcome === 'deny') return blocked(trust);
      if (d.outcome === 'request') gated = true;
    }
    if (gated) {
      // The builder's human asked to see customer intros first: the stranger-request flow (I4).
      state = step(state, { type: 'submit', permitted: false });
      if (l0Scan(normalizeUntrusted(m.body).text, 'dm_stranger').label === 'malicious') {
        state = step(state, { type: 'verdict', action: 'block' });
        await setState(tx, m.id, state, { trust });
        return { state, path: null, note: 'blocked', relationship: rel };
      }
      await setState(tx, m.id, state, { trust });
      for (const p of rcpts) await addReview(tx, p.owner_user_id, 'dm_request', wire('message', m.id), p.p_id, 'New question from a customer of your product');
      return { state, path: 'owner_notification', note: 'awaiting_human_accept', relationship: rel };
    }

    state = step(state, { type: 'submit', permitted: true });
    await openSupportThread(tx, m.thread_id, ctx.teamId);
    // A customer's human is screened like their agent (never as a teammate `comment`).
    const contentClass = mate ? 'dm_teammate' : 'dm_stranger';
    const out = await screen({ contentClass, contentId: wire('message', m.id), text: m.body }, {});
    await storeVerdict(tx, m.id, out);
    let action: ScreenAction = actionFor(contentClass, out.screen.label).action;
    // The support thread is the intro gate (the builder asked for questions by claiming the product);
    // the human gate sits on the builder's replies instead.
    if (action === 'request_flow') action = 'allow';
    state = step(state, { type: 'verdict', action });
    await setState(tx, m.id, state, { trust, delivered: state === 'delivered' });
    if (state === 'quarantined') {
      for (const p of rcpts) await addReview(tx, p.owner_user_id, 'quarantined_message', wire('message', m.id), p.p_id, 'A message to your agent was quarantined by screening');
      return { state, path: null, note: 'quarantined', relationship: rel };
    }
    if (state !== 'delivered') return { state, path: null, note: noteFor(state, null), relationship: rel };
    await deliver(tx, deps, m, rcpts.map((p) => ({ agentId: p.p_id, ownerId: p.owner_user_id, wake: false })), events);
    if (m.thread_state === 'resolved') await openThread(tx, m.thread_id, ['resolved']);
    await adoptSubject(tx, m.thread_id, contentClass);
    await recordBugReport(tx, ctx.productId, m);
    return { state, path: 'inbox', note: 'next_turn', relationship: rel };
  }

  // The builder side: replies to the customer agent(s).
  const rcpts = customerParts(ctx, parts);
  if (rcpts.length === 0) return blocked();
  const mate = await trustedRel(tx, senderOwner, rcpts.map((p) => p.owner_user_id));
  const trust = human ? 'human_comment' : mate ? 'teammate' : 'stranger';
  const rel: Relationship = mate ?? 'stranger';

  // The builder's own human writing in the thread is the human gesture (I5): sent like auto_send.
  if (ctx.replyPolicy === 'auto_send' || human) {
    state = step(state, { type: 'submit', permitted: true });
    const out = await screen({ contentClass: 'builder_answer', contentId: wire('message', m.id), text: m.body }, {});
    await storeVerdict(tx, m.id, out);
    state = step(state, { type: 'verdict', action: actionFor('builder_answer', out.screen.label).action });
    await setState(tx, m.id, state, { trust, delivered: state === 'delivered' });
    return finishBuilderReply(tx, deps, m, rcpts, state, events, rel);
  }

  // builder_approves: the draft waits for the builder's own human (I5).
  state = step(state, { type: 'submit', permitted: false });
  const out = await screen({ contentClass: 'builder_answer', contentId: wire('message', m.id), text: m.body }, {});
  await storeVerdict(tx, m.id, out);
  if (out.screen.label === 'malicious') {
    state = step(state, { type: 'verdict', action: 'block' });
    await setState(tx, m.id, state, { trust });
    return { state, path: null, note: 'blocked', relationship: rel };
  }
  await setState(tx, m.id, state, { trust });
  await addReview(tx, ctx.builderOwner, 'builder_reply', wire('message', m.id), ctx.builderId, BUILDER_REPLY_SUMMARY);
  return { state, path: 'owner_notification', note: 'awaiting_human_accept', relationship: rel };
}

/** After the builder_answer verdict: quarantine → the customer's human reviews it; delivered → the customer's inbox. */
async function finishBuilderReply(
  tx: Tx, deps: CoreDeps, m: MsgRow, rcpts: readonly Part[], state: MessageState, events: PushEvent[], rel: Relationship,
): Promise<RouteResult> {
  if (state === 'quarantined') {
    for (const p of rcpts) await addReview(tx, p.owner_user_id, 'quarantined_message', wire('message', m.id), p.p_id, 'A message to your agent was quarantined by screening');
    return { state, path: null, note: 'quarantined', relationship: rel };
  }
  if (state !== 'delivered') return { state, path: null, note: noteFor(state, null), relationship: rel };
  // Builder answers never wake the customer's agent either: it reads them next turn.
  await deliver(tx, deps, m, rcpts.map((p) => ({ agentId: p.p_id, ownerId: p.owner_user_id, wake: false })), events);
  if (m.thread_state === 'resolved') await openThread(tx, m.thread_id, ['resolved']);
  return { state, path: 'inbox', note: 'next_turn', relationship: rel };
}

export interface SupportDelivery { productId: string; teamId: string; side: Side; rcpts: Part[] }

/**
 * Recipients for a held support message a human released or accepted
 * (applyMessageDecision): the same role rules as routing. Null when the
 * product is no longer active, or the sender no longer speaks for its side
 * (a replaced builder): nothing may be delivered then.
 */
export async function supportDeliveryFor(tx: Tx, m: MsgRow): Promise<SupportDelivery | null> {
  const ctx = await supportContext(tx, m.thread_id);
  if (!live(ctx)) return null;
  const parts = (await tx.query<Part>(
    `select p_id, owner_user_id from public.thread_participants where thread_id = $1 and p_kind = 'agent'`, [m.thread_id])).rows;
  const side = sideOf(ctx, m, parts);
  if (!side) return null;
  if (side === 'builder') return { productId: ctx.productId, teamId: ctx.teamId, side, rcpts: customerParts(ctx, parts) };
  await syncSupportBuilders(tx, ctx.productId, m.thread_id);
  return { productId: ctx.productId, teamId: ctx.teamId, side, rcpts: [{ p_id: ctx.builderId, owner_user_id: ctx.builderOwner }] };
}

/** After a released/accepted support message was delivered: open under the product's team; bug reports become tasks. */
export async function supportDelivered(tx: Tx, sd: SupportDelivery, m: MsgRow) {
  await openSupportThread(tx, m.thread_id, sd.teamId);
  if (sd.side === 'customer') await recordBugReport(tx, sd.productId, m);
}

/**
 * The builder's human decided a `builder_reply` review item (enqueued by
 * the review decision route; the gesture is checked there). Approve, with an
 * optional edited body (outbound DLP again: a hit holds the draft for its
 * owner, nothing is sent), screens as `builder_answer` and delivers to the
 * customer agent(s). Reject: the customer never sees anything. A draft whose
 * product was suspended, or whose agent was replaced as the builder, since
 * it was written is declined whatever the decision.
 */
export async function applyBuilderReplyDecision(
  deps: CoreDeps, messageWireId: string, decision: 'approve' | 'reject', edits: { body?: string } = {},
): Promise<MessageState> {
  const id = messageWireId.replace(/^m_/, '');
  const events: PushEvent[] = [];
  const state = await deps.db.asService(async (tx) => {
    const m = (await tx.query<MsgRow>(MSG_SELECT, [id])).rows[0];
    if (!m) throw new HttpError('NOT_FOUND', 'message not found');
    if (m.thread_kind !== 'support' || m.state !== 'request_pending') throw new HttpError('CONFLICT', `message in state ${m.state} has no pending builder reply`);
    const ctx = await supportContext(tx, m.thread_id);
    if (!ctx || m.sender_kind !== 'agent' || !m.sender_id || ctx.roles.get(m.sender_id) === 'customer') throw new HttpError('CONFLICT', 'not a builder reply');
    let s: MessageState = m.state;
    // Suspended since, or the drafting agent is no longer the product's builder: the draft is declined, never sent.
    const stale = !live(ctx) || m.sender_id !== ctx.builderId;
    if (decision === 'reject' || stale) {
      s = step(s, { type: 'request_declined' });
      await setState(tx, m.id, s);
      if (stale && decision === 'approve') deps.log('info', 'builder reply declined: product inactive or builder replaced', { messageId: wire('message', m.id) });
      return s;
    }
    const parts = await tx.query<Part>(
      `select p_id, owner_user_id from public.thread_participants where thread_id = $1 and p_kind = 'agent'`, [m.thread_id]);
    let body = m.body;
    if (edits.body !== undefined && edits.body !== m.body) {
      const dlp = dlpScan(edits.body, { allowShortCode: false });
      if (!dlp.ok || edits.body.length > CROSS_OWNER_BODY_MAX) {
        // The edited text would carry code or a secret off the team (I10): hold the original draft for its owner.
        s = step(s, { type: 'verdict', action: 'hold_for_sender' });
        await setState(tx, m.id, s);
        deps.log('info', 'edited builder reply held by outbound DLP', { messageId: wire('message', m.id), rules: dlp.findings.map((f) => f.rule) });
        return s;
      }
      body = edits.body;
      await tx.query(`update public.messages set body = $2, updated_at = now() where id = $1`, [m.id, body]);
    }
    s = step(s, { type: 'request_accepted' });
    const out = await screen({ contentClass: 'builder_answer', contentId: wire('message', m.id), text: body }, {});
    await storeVerdict(tx, m.id, out);
    s = step(s, { type: 'verdict', action: actionFor('builder_answer', out.screen.label).action });
    await setState(tx, m.id, s, { delivered: s === 'delivered' });
    await finishBuilderReply(tx, deps, { ...m, body }, customerParts(ctx, parts.rows), s, events, 'stranger');
    return s;
  });
  for (const e of events) await deps.bus.publish(e);
  return state;
}
