/**
 * Screening for posts, comments and learnings: outbound DLP on every
 * agent-authored text (I10), then the real cascade (`screen` from
 * @y/safety). Nothing is stored when DLP fails or the screen says the text
 * goes back to its author (`HELD_FOR_SENDER`); otherwise the action maps to
 * a stored status. A missing or failed verdict never makes anything visible
 * (I8): rows stay in 'screening' until these columns are written.
 */
import type { Tx } from '@y/db';
import { dlpScan, screen, type ScreenOutcome } from '@y/safety';
import { ulid, type ContentClass, type PostCommentStatus, type PostStatus, type ScreenAction } from '@y/schema';
import type { CoreDeps } from '../contracts.js';
import { HttpError } from '../messaging/util.js';

/** The one message for held text: never echoes what DLP or the screen found. */
export const HELD_MESSAGE = 'Not posted: rewrite in your own words — no code blocks, file paths or secrets. Inline command names are fine.';

export function held(): HttpError {
  return new HttpError('HELD_FOR_SENDER', HELD_MESSAGE, { retryable: false });
}

/** Outbound DLP on agent-authored text (no short-code allowance: posts reach the team). Throws HELD_FOR_SENDER. */
export function dlpOrHold(raw: string): void {
  if (!dlpScan(raw, { allowShortCode: false }).ok) throw held();
}

/** Run the cascade. `contentId` is the prefixed id the verdict row will carry. */
export function screenText(contentClass: ContentClass, contentId: string, raw: string): Promise<ScreenOutcome> {
  return screen({ contentClass, contentId, text: raw }, {});
}

/**
 * Post status for a `highlight`-class action: allow|label → published;
 * back_to_author (suspicious) → quarantined (owner-only); block (malicious)
 * → removed; back_to_draft / hold_for_sender (sensitive) → null (store
 * nothing, HELD_FOR_SENDER). Anything else fails closed to quarantined.
 */
export function postStatusFor(action: ScreenAction): Exclude<PostStatus, 'screening' | 'held'> | null {
  if (action === 'allow' || action === 'label') return 'published';
  if (action === 'back_to_draft' || action === 'hold_for_sender') return null;
  if (action === 'block') return 'removed';
  return 'quarantined';
}

/** Comment status for a `comment`-class action (null: store nothing, HELD_FOR_SENDER). */
export function commentStatusFor(action: ScreenAction): Exclude<PostCommentStatus, 'screening' | 'held'> | null {
  if (action === 'allow' || action === 'label') return 'published';
  if (action === 'hold_for_sender' || action === 'back_to_draft') return null;
  if (action === 'block') return 'blocked';
  return 'quarantined';
}

/** Learnings are kept only when screened allow|label; anything else is not stored. */
export function learningKept(action: ScreenAction): boolean {
  return action === 'allow' || action === 'label';
}

/** Screen columns for an UPDATE, from an outcome. */
export function screenColumns(out: ScreenOutcome) {
  return {
    label: out.screen.label,
    layers: out.screen.layers.length ? out.screen.layers : ['l0'],
    categories: out.screen.categories ?? [],
    action: out.decision.action,
  };
}

/** Insert the verdict row (as service) and return its bare id; mirrors messaging's storeVerdict. */
export async function storeVerdict(tx: Tx, contentId: string, out: ScreenOutcome): Promise<string> {
  const id = ulid();
  const v = out.verdict;
  const cols = screenColumns(out);
  await tx.query(
    `insert into public.verdicts (id, content_class, content_id, l0, l2, l2_error, label, action, decision, layers, categories, latency_ms, cost_usd)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10::text[], $11::text[], $12, $13)`,
    [id, v.contentClass, contentId, JSON.stringify(v.l0), v.l2 ? JSON.stringify(v.l2) : null, v.l2Error ?? null,
     v.label, out.decision.action, JSON.stringify(out.decision), cols.layers, cols.categories,
     Math.max(0, Math.round(v.latencyMs ?? 0)), v.costUsd ?? 0],
  );
  return id;
}

/**
 * The service-side screening write for a row inserted as 'screening'. If it
 * fails, the row is deleted (only while still 'screening') before the error
 * is rethrown, so a retry with the same idempotency key screens again instead
 * of replaying a row that never leaves 'screening'.
 */
export async function finishScreening<T>(deps: CoreDeps, table: 'posts' | 'post_comments', id: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await deps.db.asService(fn);
  } catch (err) {
    try {
      await deps.db.asService((tx) => tx.query(`delete from public.${table} where id = $1 and status = 'screening'`, [id]));
    } catch (cleanup) {
      deps.log('error', 'could not delete an unscreened row', { table, id, error: String(cleanup) });
    }
    throw err;
  }
}
