/**
 * Slack notification jobs (spec §7): new messages, review items, decisions,
 * the team feed card and the welcome DM. Everything is read as the service
 * role; nothing quarantined or request_pending is ever rendered, and review
 * notices carry no message bodies.
 */
import type { Queryable, Tx } from '@y/db';
import { dlpScan, l0Scan, normalizeUntrusted } from '@y/safety';
import type { CoreDeps, JobHandler } from '../contracts.js';
import { takeToken } from '../platform/rate-limit.js';
import { agentInfos, userInfos } from '../messaging/util.js';
import { isPermanentSlackError, type SlackClient } from './client.js';
import { ROOM_NOTIFY_WINDOW_S, webUrl } from './config.js';
import { threadIsRoom } from './enqueue.js';
import { activeLinkFor, prefsFor } from './identity.js';
import { FeedJob, NotifyMessageJob, ReviewJob, UpdateMessageJob, WelcomeJob } from './payloads.js';
import * as R from './render.js';
import { slackJob, type SlackCtx } from './shared.js';

const PREVIEW_MAX = 200;

/** A screened, DLP-clean, escaped preview of a delivered body, or null. */
export function previewFor(body: string, contentClass: 'comment' | 'dm_teammate'): string | null {
  const text = normalizeUntrusted(body).text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (!text) return null;
  if (l0Scan(text, contentClass).label !== 'clean') return null;
  if (!dlpScan(text, { allowShortCode: false }).ok) return null;
  return R.safe(text, PREVIEW_MAX);
}

async function handleOf(q: Queryable, kind: string, id: string | null): Promise<string> {
  if (!id) return 'Y';
  if (kind === 'agent') return (await agentInfos(q, [id])).get(id)?.handle ?? 'agent';
  if (kind === 'user') return (await userInfos(q, [id])).get(id)?.handle ?? 'someone';
  return 'Y';
}

async function agentHandle(q: Queryable, id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await agentInfos(q, [id])).get(id)?.handle ?? null;
}

/* ------------------------------------------------------- notify_message */

function notifyMessage(ctx: SlackCtx): JobHandler {
  return slackJob(ctx, async (payload, deps, client) => {
    const p = NotifyMessageJob.safeParse(payload);
    if (!p.success) { deps.log('warn', 'slack.notify_message: bad payload'); return; }
    const { userId, threadId, messageId } = p.data;
    const web = webUrl(deps.config);
    const plan = await deps.db.asService(async (tx) => {
      const m = (await tx.query<{ state: string; sender_kind: string; sender_id: string | null; body: string; thread_id: string }>(
        `select state, sender_kind, sender_id, body, thread_id from public.messages where id = $1`, [messageId])).rows[0];
      // Never quarantined, request_pending or held bodies (or notices for them).
      if (!m || m.thread_id !== threadId || (m.state !== 'delivered' && m.state !== 'released')) return null;
      const t = (await tx.query<{ subject: string; kind: string }>(`select subject, kind from public.threads where id = $1`, [threadId])).rows[0];
      if (!t) return null;
      const link = await activeLinkFor(tx, userId);
      if (!link) return null;
      const prefs = await prefsFor(tx, userId);
      if (!prefs.slack || prefs.kinds.dm === false) return null;
      const isRoom = await threadIsRoom(tx, threadId, t.kind);
      const ok = await rateOk(tx, userId, threadId, isRoom);
      if (!ok) return null;
      const parts = (await tx.query<{ p_kind: string; p_id: string; owner_user_id: string }>(
        `select p_kind, p_id, owner_user_id from public.thread_participants where thread_id = $1`, [threadId])).rows;
      const own = parts.filter((x) => x.p_kind === 'agent' && x.owner_user_id === userId);
      const others = parts.filter((x) => (x.p_kind === 'agent' && x.owner_user_id !== userId) || (x.p_kind === 'user' && x.p_id !== userId));
      const ownHandle = await agentHandle(tx, own[0]?.p_id ?? null);
      const sender = await handleOf(tx, m.sender_kind, m.sender_id);
      const preview = previewFor(m.body, m.sender_kind === 'user' ? 'comment' : 'dm_teammate');
      const senderIsOwnAgent = m.sender_kind === 'agent' && own.some((x) => x.p_id === m.sender_id);
      const verb: R.MessageVerb = isRoom ? { kind: 'room' }
        : m.sender_kind === 'user' ? { kind: 'commented' }
          : !senderIsOwnAgent && ownHandle ? { kind: 'agent_dm', agent: ownHandle } : { kind: 'replied' };
      const bridge = (await tx.query<{ thread_ts: string }>(
        `select thread_ts from public.thread_bridges where thread_id = $1 and slack_team_id = $2 and for_user_id = $3 limit 1`,
        [threadId, link.slackTeamId, userId])).rows[0];
      return { link, subject: t.subject, isRoom, sender, preview, verb, instructAgent: others.length === 0 ? ownHandle : null, bridgeTs: bridge?.thread_ts ?? null };
    });
    if (!plan) return;
    const channel = await client.openIm(plan.link.slackUserId);
    if (plan.bridgeTs) {
      await client.postMessage({ channel, threadTs: plan.bridgeTs, ...R.n2({ sender: plan.sender, preview: plan.preview }) });
      return;
    }
    const url = R.links.thread(web, threadId);
    const msg = plan.isRoom
      ? R.nRoom({ sender: plan.sender, subject: plan.subject, preview: plan.preview, url })
      : R.n1({ sender: plan.sender, subject: plan.subject, preview: plan.preview, url, verb: plan.verb, instructAgent: plan.instructAgent });
    const posted = await client.postMessage({ channel, ...msg });
    if (!/^[0-9]{1,12}\.[0-9]{1,8}$/.test(posted.ts)) return;
    await deps.db.asService((tx) => tx.query(
      `insert into public.thread_bridges (thread_id, slack_team_id, channel_id, thread_ts, for_user_id)
       values ($1, $2, $3, $4, $5) on conflict do nothing`,
      [threadId, plan.link.slackTeamId, posted.channel || channel, posted.ts, userId]));
  });
}

async function rateOk(tx: Tx, userId: string, threadId: string, isRoom: boolean): Promise<boolean> {
  const t = isRoom
    ? await takeToken(tx, 'slack:room', [userId, threadId], { rate: 1 / ROOM_NOTIFY_WINDOW_S, burst: 1 })
    : await takeToken(tx, 'slack:thread', [userId, threadId], { rate: 6 / 300, burst: 6 });
  if (!t.allowed) return false;
  return (await takeToken(tx, 'slack:user', [userId], { rate: 60 / 3600, burst: 60 })).allowed;
}

/* -------------------------------------------------------- notify_review */

const KIND_PREF: Record<string, string> = {
  dm_request: 'dm_request', quarantined_message: 'quarantine', draft: 'draft', change_request: 'change_request', builder_reply: 'builder_reply',
};

/** Render the pending review notice for a row (service queryable). Never includes message bodies. */
export async function renderReview(q: Queryable, web: string, row: Record<string, unknown>): Promise<R.SlackMessage> {
  const id = String(row.id);
  const kind = String(row.kind);
  const url = R.links.review(web, id);
  const agent = await agentHandle(q, (row.agent_id as string | null) ?? null);
  const refMsg = typeof row.ref_id === 'string' && row.ref_id.startsWith('m_') ? row.ref_id.slice(2) : null;
  if (kind === 'dm_request' && refMsg) {
    const m = (await q.query<{ sender_kind: string; sender_id: string | null; body: string }>(
      `select sender_kind, sender_id, body from public.messages where id = $1`, [refMsg])).rows[0];
    const info = m?.sender_kind === 'agent' && m.sender_id ? (await agentInfos(q, [m.sender_id])).get(m.sender_id) : undefined;
    // Only the L0 label of the normalized intro: no text (I4).
    const label = m ? l0Scan(normalizeUntrusted(m.body).text, 'dm_stranger').label : 'unknown';
    return R.rvDmRequest({ reviewId: id, agent: info?.handle ?? 'an agent', owner: info?.ownerHandle ?? 'unknown', yourAgent: agent ?? 'your agent', label, url });
  }
  if (kind === 'quarantined_message' && refMsg) {
    const m = (await q.query<{ sender_kind: string; sender_id: string | null; subject: string }>(
      `select m.sender_kind, m.sender_id, t.subject from public.messages m join public.threads t on t.id = m.thread_id where m.id = $1`, [refMsg])).rows[0];
    return R.rvQuarantined({ reviewId: id, sender: m ? await handleOf(q, m.sender_kind, m.sender_id) : 'someone', subject: m?.subject ?? '', url });
  }
  if (kind === 'draft') return R.rvDraft({ reviewId: id, agent: agent ?? 'your agent', summary: String(row.summary ?? ''), url });
  return R.rvChange({ kind, agent: agent ?? 'your agent', summary: String(row.summary ?? ''), url });
}

export async function renderReviewDone(q: Queryable, web: string, row: Record<string, unknown>, opts: { already?: boolean; byYou?: boolean } = {}): Promise<R.SlackMessage> {
  const agent = await agentHandle(q, (row.agent_id as string | null) ?? null);
  return R.rvDone({
    kind: String(row.kind), state: String(row.state), decision: (row.decision as string | null) ?? null, via: (row.decided_via as string | null) ?? null,
    at: row.decided_at ? new Date(row.decided_at as string) : null, agent, url: R.links.review(web, String(row.id)), ...opts,
  });
}

function notifyReview(ctx: SlackCtx): JobHandler {
  return slackJob(ctx, async (payload, deps, client) => {
    const p = ReviewJob.safeParse(payload);
    if (!p.success) { deps.log('warn', 'slack.notify_review: bad payload'); return; }
    const web = webUrl(deps.config);
    const plan = await deps.db.asService(async (tx) => {
      const row = (await tx.query<Record<string, unknown>>(`select * from public.review_items where id = $1`, [p.data.reviewId])).rows[0];
      if (!row || row.state !== 'pending') return null;
      const owner = String(row.owner_user_id);
      const link = await activeLinkFor(tx, owner);
      if (!link) return null;
      const prefs = await prefsFor(tx, owner);
      const pref = KIND_PREF[String(row.kind)];
      if (!prefs.slack || (pref && prefs.kinds[pref] === false)) return null;
      return { link, msg: await renderReview(tx, web, row) };
    });
    if (!plan) return;
    const channel = await client.openIm(plan.link.slackUserId);
    const posted = await client.postMessage({ channel, ...plan.msg });
    if (!/^[0-9]{1,12}\.[0-9]{1,8}$/.test(posted.ts)) return;
    await deps.db.asService(async (tx) => {
      await tx.query(
        `insert into public.slack_review_posts (review_id, slack_team_id, channel_id, ts) values ($1, $2, $3, $4)
         on conflict (review_id, channel_id) do update set ts = excluded.ts`,
        [p.data.reviewId, plan.link.slackTeamId, posted.channel || channel, posted.ts]);
      await tx.query(`update public.review_items set slack_sent = true where id = $1`, [p.data.reviewId]);
    });
  });
}

/* ------------------------------------------------------- review_decided */

function reviewDecided(ctx: SlackCtx): JobHandler {
  return slackJob(ctx, async (payload, deps, client) => {
    const p = ReviewJob.safeParse(payload);
    if (!p.success) return;
    const web = webUrl(deps.config);
    const plan = await deps.db.asService(async (tx) => {
      const row = (await tx.query<Record<string, unknown>>(`select * from public.review_items where id = $1`, [p.data.reviewId])).rows[0];
      if (!row || row.state === 'pending') return null;
      const posts = (await tx.query<{ channel_id: string; ts: string }>(
        `select channel_id, ts from public.slack_review_posts where review_id = $1`, [p.data.reviewId])).rows;
      return { posts, msg: await renderReviewDone(tx, web, row) };
    });
    if (!plan) return;
    for (const post of plan.posts) {
      try {
        await client.updateMessage({ channel: post.channel_id, ts: post.ts, ...plan.msg });
      } catch (e) {
        // One gone message must not block the others.
        if (!isPermanentSlackError(e)) throw e;
        deps.log('warn', 'slack.review_decided: update failed', { code: e.code });
      }
    }
  });
}

/* --------------------------------------------------------- feed_activity */

function feedActivity(ctx: SlackCtx): JobHandler {
  return slackJob(ctx, async (payload, deps, client) => {
    const p = FeedJob.safeParse(payload);
    if (!p.success) return;
    const web = webUrl(deps.config);
    const plan = await deps.db.asService(async (tx) => {
      // Team visibility only: never private, repo or public cards.
      const a = (await tx.query<{ title: string; tool_calls: number; tokens_total: string | number; wall_ms: string | number; outcome_status: string; turns: number; agent_id: string; team_id: string | null }>(
        `select title, tool_calls, tokens_total, wall_ms, outcome_status::text as outcome_status, turns, agent_id, team_id
           from public.activities where id = $1 and status = 'published' and visibility = 'team'`, [p.data.activityId])).rows[0];
      if (!a || !a.team_id) return null;
      const ch = (await tx.query<{ channel_id: string }>(`select channel_id from public.team_slack_channels where team_id = $1`, [a.team_id])).rows[0];
      if (!ch) return null;
      const agent = await agentHandle(tx, a.agent_id);
      return {
        channel: ch.channel_id,
        msg: R.a1({
          title: a.title, agent: agent ?? 'an agent', outcome: a.outcome_status, toolCalls: Number(a.tool_calls), tokens: Number(a.tokens_total),
          wallMs: Number(a.wall_ms), turns: Number(a.turns), url: R.links.activity(web, p.data.activityId),
        }),
      };
    });
    if (!plan) return;
    await client.postMessage({ channel: plan.channel, ...plan.msg });
  });
}

/* --------------------------------------------------------------- welcome */

function welcome(ctx: SlackCtx): JobHandler {
  return slackJob(ctx, async (payload, deps, client) => {
    const p = WelcomeJob.safeParse(payload);
    if (!p.success) return;
    const plan = await deps.db.asService(async (tx) => {
      const link = await activeLinkFor(tx, p.data.userId);
      if (!link) return null;
      return { link, handle: (await userInfos(tx, [p.data.userId])).get(p.data.userId)?.handle ?? 'you' };
    });
    if (!plan) return;
    const channel = await client.openIm(plan.link.slackUserId);
    await client.postMessage({ channel, ...R.w1(plan.handle, webUrl(deps.config)) });
  });
}

/* --------------------------------------------------------- update_message */

/** Re-render a review or pending-instruction message from the DB (fallback when an inline chat.update failed). */
export async function renderForUpdate(q: Queryable, web: string, kind: 'review' | 'pending', id: string): Promise<R.SlackMessage | null> {
  if (kind === 'review') {
    const row = (await q.query<Record<string, unknown>>(`select * from public.review_items where id = $1`, [id])).rows[0];
    if (!row || row.state === 'pending') return null;
    return renderReviewDone(q, web, row);
  }
  const r = (await q.query<{ state: string; owner_instruction_id: string | null; agent_handle: string | null }>(
    `select p.state, p.owner_instruction_id, a.handle::text as agent_handle from public.slack_pending_instructions p
       left join public.owner_instructions o on o.id = p.owner_instruction_id left join public.agents a on a.id = o.agent_id
      where p.id = $1`, [id])).rows[0];
  if (!r || r.state === 'pending') return null;
  return R.pDone(r.state === 'confirmed' ? 'sent' : r.state === 'cancelled' ? 'cancelled' : 'expired', r.agent_handle);
}

function updateMessage(ctx: SlackCtx): JobHandler {
  return slackJob(ctx, async (payload, deps, client) => {
    const p = UpdateMessageJob.safeParse(payload);
    if (!p.success) return;
    const msg = await deps.db.asService((tx) => renderForUpdate(tx, webUrl(deps.config), p.data.kind, p.data.id));
    if (!msg) return;
    await client.updateMessage({ channel: p.data.channel, ts: p.data.ts, ...msg });
  });
}

export function notifyJobs(ctx: SlackCtx): Record<string, JobHandler> {
  return {
    'slack.notify_message': notifyMessage(ctx),
    'slack.notify_review': notifyReview(ctx),
    'slack.review_decided': reviewDecided(ctx),
    'slack.feed_activity': feedActivity(ctx),
    'slack.welcome': welcome(ctx),
    'slack.update_message': updateMessage(ctx),
  };
}

export type { SlackClient };
