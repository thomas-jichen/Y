/**
 * One human decision on a review item, shared by the web route and Slack
 * buttons. Runs inside the caller's asUser transaction: RLS ties the item to
 * the signed-in (or linked Slack) owner, and api.decide_review is the CAS
 * (pending + not expired; `via` must match the claims). The side effects
 * (`review.<kind>`) are enqueued in the same transaction.
 */
import type { Tx } from '@y/db';
import { dlpScan } from '@y/safety';
import { CROSS_OWNER_BODY_MAX, DECISIONS_BY_KIND, type DecisionRequest, type ReviewItem, type ReviewKind } from '@y/schema';
import type { CoreDeps } from '../contracts.js';
import { reviewItemsFromRows } from './mappers.js';

export type DecideResult =
  | { status: 200; item: ReviewItem; row: Record<string, unknown>; replay: boolean }
  | { status: 404 }
  | { status: 400; msg: string }
  | { status: 409; row?: Record<string, unknown> };

export async function decideReviewTx(
  tx: Tx,
  deps: CoreDeps,
  a: { reviewId: string; decision: DecisionRequest['decision']; decisionId: string; via: 'web' | 'slack'; edits?: DecisionRequest['edits'] },
): Promise<DecideResult> {
  const row = (await tx.query<Record<string, unknown>>('select * from public.review_items where id = $1', [a.reviewId])).rows[0];
  if (!row) return { status: 404 };
  const kind = row.kind as ReviewKind;
  const allowed = DECISIONS_BY_KIND[kind] as readonly string[];
  if (!allowed.includes(a.decision)) return { status: 400, msg: `decision ${a.decision} is not valid for ${kind}` };
  if (a.decision === 'hold') return { status: 400, msg: 'hold is not supported yet' };
  if (row.state !== 'pending' && row.decision_id === a.decisionId) {
    const [same] = await reviewItemsFromRows(tx, [row]);
    return { status: 200, item: same!, row, replay: true }; // idempotent replay
  }
  if (kind === 'builder_reply' && a.decision === 'approve' && row.state === 'pending') {
    const refused = await builderReplyRefusal(tx, String(row.ref_id), a.edits?.body);
    if (refused) return { status: 400, msg: refused };
  }
  const state = a.decision === 'reject' ? 'rejected' : 'approved';
  const decided = await tx.query<Record<string, unknown>>('select * from api.decide_review($1, $2, $3, $4, $5)', [
    a.reviewId,
    state,
    a.decisionId,
    a.via,
    a.decision,
  ]);
  const updated = decided.rows[0];
  if (!updated) {
    const cur = (await tx.query<Record<string, unknown>>('select * from public.review_items where id = $1', [a.reviewId])).rows[0];
    return cur ? { status: 409, row: cur } : { status: 409 };
  }
  // Side effects run in the worker: 'review.draft' (platform) or 'review.<kind>' handlers of other modules.
  await deps.jobs.enqueue(
    `review.${kind}`,
    { reviewId: a.reviewId, refId: String(row.ref_id), decision: a.decision, ...(a.edits ? { edits: a.edits } : {}) },
    { dedupeKey: `review:${a.reviewId}`, tx },
  );
  const [item] = await reviewItemsFromRows(tx, [updated]);
  return { status: 200, item: item!, row: updated, replay: false };
}

/**
 * Why approving a builder reply would send nothing, checked before the item
 * is marked approved (the worker re-checks, and holds or declines, anyway):
 * an edit over the cross-owner limit or with code/secrets (I10), or a draft
 * whose product is no longer active or whose agent is no longer its builder.
 * Under the caller's RLS: a draft the owner can no longer see is refused too.
 */
async function builderReplyRefusal(tx: Tx, refId: string, body: string | undefined): Promise<string | null> {
  if (body !== undefined) {
    if (body.length > CROSS_OWNER_BODY_MAX) return `a reply to a customer is at most ${CROSS_OWNER_BODY_MAX} characters`;
    if (!dlpScan(body, { allowShortCode: false }).ok) return 'the edited reply looks like it contains code or a secret; remove it and send again';
  }
  const r = await tx.query(
    `select 1 from public.messages m join public.threads t on t.id = m.thread_id join public.products p on p.id = t.product_id
      where m.id = $1 and p.status = 'active' and p.builder_agent_id = m.sender_id`, [refId.replace(/^m_/, '')]);
  return r.rowCount ? null : 'this product is no longer active, or your agent is no longer its builder';
}
