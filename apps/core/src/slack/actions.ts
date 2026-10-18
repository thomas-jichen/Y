/**
 * Interactivity (spec §9): review buttons and instruction Confirm/Cancel.
 *
 * The Slack gesture (I5) = a verified request signature + an active link
 * from the clicking Slack user to a Y user + the click. Review decisions go
 * through the same CAS as the web (api.decide_review under
 * asUser({sub, via:'slack'})), so RLS ties the item to the linked owner and a
 * second click gets "Already decided". Owner instructions from Slack exist
 * only after Confirm on a CAS-guarded pending row.
 */
import { isSqlState } from '@y/db';
import type { CoreDeps } from '../contracts.js';
import { issueOwnerInstruction } from '../messaging/instruct.js';
import { HttpError } from '../messaging/util.js';
import { decideReviewTx } from '../platform/review-decide.js';
import { bareId } from '../platform/util.js';
import type { SlackClient } from './client.js';
import { INLINE_SLACK_TIMEOUT_MS, slackClaims, webUrl } from './config.js';
import { linkedUserFor } from './identity.js';
import { renderReviewDone } from './notify.js';
import type { BlockActions } from './payloads.js';
import * as R from './render.js';

const REVIEW_ACTIONS = { y_rv_approve: 'approve', y_rv_reject: 'reject', y_rv_release: 'release' } as const;
const INLINE = { timeoutMs: INLINE_SLACK_TIMEOUT_MS };

export async function handleBlockActions(deps: CoreDeps, client: SlackClient, p: BlockActions): Promise<void> {
  const action = p.actions[0]!;
  if (action.action_id === 'y_open') return;
  const team = p.team.id;
  const slackUser = p.user.id;
  const channel = p.container.channel_id ?? p.channel?.id;
  const ts = p.container.message_ts ?? p.message?.ts;
  if (!channel || !ts) return;

  // Replays (Slack retries, double submits) are no-ops.
  const fresh = await deps.db.asService(async (tx) => {
    const r = await tx.query(`insert into public.slack_events_seen (event_id) values ($1) on conflict do nothing returning event_id`,
      [`act:${team}:${slackUser}:${action.action_ts}`]);
    return r.rowCount > 0;
  });
  if (!fresh) return;

  const uid = await deps.db.asService((tx) => linkedUserFor(tx, team, slackUser));
  const ephemeral = (text: string) => safeCall(deps, () => client.postEphemeral({ channel, user: slackUser, text }, INLINE));
  if (!uid) { await ephemeral(R.E1); return; }
  const claims = slackClaims(uid);
  const web = webUrl(deps.config);
  const update = async (msg: R.SlackMessage, fallback: { kind: 'review' | 'pending'; id: string }) => {
    const ok = await safeCall(deps, () => client.updateMessage({ channel, ts, ...msg }, INLINE));
    if (!ok) {
      await deps.jobs.enqueue('slack.update_message', { channel, ts, kind: fallback.kind, id: fallback.id },
        { dedupeKey: `slack:upd:${channel}:${ts}:${action.action_ts}` });
    }
  };

  if (action.action_id in REVIEW_ACTIONS) {
    const reviewId = bareId('rv', action.value ?? '');
    if (!reviewId) return;
    const decision = REVIEW_ACTIONS[action.action_id as keyof typeof REVIEW_ACTIONS];
    const decisionId = `slk_${action.action_ts.replace('.', '_')}_${slackUser}`;
    let res;
    try {
      res = await deps.db.asUser(claims, async (tx) => {
        // Accepting a stranger intro delivers text nobody has read in Slack (I4/I8): web only, even from an old button.
        const kind = (await tx.query<{ kind: string }>('select kind from public.review_items where id = $1', [reviewId])).rows[0]?.kind;
        if (kind === 'dm_request' && decision === 'approve') return { status: 403 as const };
        return decideReviewTx(tx, deps, { reviewId, decision, decisionId, via: 'slack' });
      });
    } catch (e) {
      if (isSqlState(e, '23505') || isSqlState(e, '42501')) { await ephemeral('Y could not record that decision.'); return; }
      throw e;
    }
    if (res.status === 403) { await ephemeral(`Read the intro and accept it on the web: ${R.links.review(web, reviewId)}`); return; }
    if (res.status === 404) { await ephemeral("This item isn't yours."); return; }
    if (res.status === 400) { await ephemeral('That decision is not available for this item.'); return; }
    const row = res.row;
    if (!row) { await ephemeral('This item was already decided or has expired.'); return; }
    const msg = await deps.db.asService((tx) => renderReviewDone(tx, web, row, res.status === 409 ? { already: true } : { byYou: true }));
    await update(msg, { kind: 'review', id: reviewId });
    return;
  }

  if (action.action_id === 'y_oi_confirm' || action.action_id === 'y_oi_cancel') {
    const [pendingId, agentId] = String(action.value ?? '').split('|');
    if (!pendingId || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(pendingId)) return;
    if (action.action_id === 'y_oi_confirm' && !agentId) return;
    const nowIso = deps.now().toISOString();
    const want = action.action_id === 'y_oi_confirm' ? 'confirmed' : 'cancelled';
    // CAS on the pending row (service role: the table is service-only).
    const taken = await deps.db.asService(async (tx) => {
      const r = await tx.query<{ thread_id: string; body: string; expired: boolean; state: string }>(
        `select thread_id, body, state, (expires_at <= $4::timestamptz) as expired from public.slack_pending_instructions
          where id = $1 and user_id = $2 and slack_user_id = $3 for update`, [pendingId, uid, slackUser, nowIso]);
      const row = r.rows[0];
      if (!row) return { outcome: 'missing' as const };
      if (row.state !== 'pending') return { outcome: 'handled' as const };
      if (row.expired) {
        await tx.query(`update public.slack_pending_instructions set state = 'expired', body = null, decided_at = $2 where id = $1`, [pendingId, nowIso]);
        return { outcome: 'expired' as const };
      }
      await tx.query(`update public.slack_pending_instructions set state = $2, body = null, decided_at = $3 where id = $1`, [pendingId, want, nowIso]);
      return { outcome: 'taken' as const, threadId: row.thread_id, body: row.body };
    });
    if (taken.outcome === 'missing') { await ephemeral("This request isn't yours."); return; }
    if (taken.outcome !== 'taken') { await update(R.pDone(taken.outcome), { kind: 'pending', id: pendingId }); return; }
    if (want === 'cancelled') { await update(R.pDone('cancelled'), { kind: 'pending', id: pendingId }); return; }
    let out: Awaited<ReturnType<typeof issueOwnerInstruction>>;
    try {
      out = await issueOwnerInstruction(deps, { userId: uid, claims, threadId: taken.threadId, agentId: agentId!, body: taken.body, via: 'slack', confirmNow: true });
      await deps.db.asService((tx) => tx.query(
        `update public.slack_pending_instructions set owner_instruction_id = $2 where id = $1`, [pendingId, out.id.replace(/^oi_/, '')]));
    } catch (e) {
      if (!(e instanceof HttpError)) {
        // The row is already 'confirmed' with its body gone: never leave it claiming "sent" for nothing.
        await recoverConfirm(deps, { pendingId, uid, threadId: taken.threadId, agentId: agentId!, body: taken.body, decidedAt: nowIso })
          .then(async (r) => { await safeCall(deps, () => client.updateMessage({ channel, ts, ...(r.sent ? R.pDone('sent', r.handle) : R.pDone('failed')) }, INLINE)); })
          .catch(() => deps.log('warn', 'slack confirm recovery failed'));
        throw e;
      }
      await deps.db.asService((tx) => tx.query(
        `update public.slack_pending_instructions set state = 'cancelled' where id = $1 and owner_instruction_id is null`, [pendingId]));
      // Re-checked under the linked user's RLS: not their agent any more, or remote instructions turned off.
      const handle = await deps.db.asService(async (tx) =>
        (await tx.query<{ handle: string }>(`select handle::text as handle from public.agents where id = $1`, [agentId])).rows[0]?.handle ?? null);
      await safeCall(deps, () => client.updateMessage({ channel, ts, ...R.pDone('remote_off', handle, web) }, INLINE));
      return;
    }
    // Stored and linked: a failure past this point (the message update) is not a send failure.
    await update(R.pDone('sent', out.handle), { kind: 'pending', id: pendingId });
  }
}

/**
 * After an unexpected error between the Confirm CAS and the end of
 * issueOwnerInstruction: if the instruction was stored anyway, link it to the
 * pending row (it was sent); otherwise mark the row cancelled so nothing
 * (message re-render, second click) reports it as sent.
 */
async function recoverConfirm(
  deps: CoreDeps,
  a: { pendingId: string; uid: string; threadId: string; agentId: string; body: string; decidedAt: string },
): Promise<{ sent: boolean; handle: string | null }> {
  return deps.db.asService(async (tx) => {
    // Already linked (by this click or a concurrent path): it was sent.
    const linked = (await tx.query<{ handle: string | null }>(
      `select a.handle::text as handle from public.slack_pending_instructions p
         join public.owner_instructions o on o.id = p.owner_instruction_id left join public.agents a on a.id = o.agent_id
        where p.id = $1`, [a.pendingId])).rows[0];
    if (linked) return { sent: true, handle: linked.handle };
    const oi = (await tx.query<{ id: string; handle: string | null }>(
      `select o.id, a.handle::text as handle from public.owner_instructions o left join public.agents a on a.id = o.agent_id
        where o.thread_id = $1 and o.agent_id = $2 and o.created_by_user_id = $3 and o.verified_via = 'slack'
          and o.body = $4 and o.created_at >= $5::timestamptz
          and not exists (select 1 from public.slack_pending_instructions p where p.owner_instruction_id = o.id and p.id <> $6)
        order by o.created_at desc limit 1`,
      [a.threadId, a.agentId, a.uid, a.body, a.decidedAt, a.pendingId])).rows[0];
    if (oi) {
      await tx.query(`update public.slack_pending_instructions set owner_instruction_id = $2 where id = $1 and owner_instruction_id is null`, [a.pendingId, oi.id]);
      return { sent: true, handle: oi.handle };
    }
    await tx.query(`update public.slack_pending_instructions set state = 'cancelled' where id = $1 and owner_instruction_id is null`, [a.pendingId]);
    return { sent: false, handle: null };
  });
}

/** Run a Slack call; false (logged by method/code only) on failure. */
async function safeCall(deps: CoreDeps, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : e instanceof Error ? e.name : 'error';
    deps.log('warn', 'slack inline call failed', { code });
    return false;
  }
}
