/**
 * Segments (intent × stack × size, or verified fixture tasks), leaderboards
 * and shared component pages (PLAN §8, UI.md §4).
 *
 * @module segments
 */
import { z } from 'zod';
import { AgentRef, Count, IsoTimestamp, Probability, SharedComponentId, Slug, singleLine } from './common.js';
import { PrMetric } from './activity.js';
import { CapabilityTag } from './llm.js';
import { Screen, StaticFinding } from './safety.js';

/** `organic` (from captured work) or `verified` (fixture task with a check script). */
export const SegmentKind = z.enum(['organic', 'verified']);
export type SegmentKind = z.infer<typeof SegmentKind>;

/** Wilson-style interval `[lo, hi]` with `lo <= hi`. */
export const Interval = z
  .tuple([z.number(), z.number()])
  .refine(([lo, hi]) => lo <= hi, { error: 'interval lower bound must be <= upper bound' });
export type Interval = z.infer<typeof Interval>;

/** One setup cluster on a leaderboard. `label` is built from screened component names. */
export const LeaderboardRow = z.object({
  clusterKey: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/),
  label: singleLine(160, 1),
  successWilson: Probability,
  successCi: Interval,
  medianTokensOnSuccess: Count,
  n: Count,
  owners: Count,
  isYou: z.boolean(),
});
export type LeaderboardRow = z.infer<typeof LeaderboardRow>;

/** A segment page with its leaderboard. Organic boards need ≥3 owners and n≥5. */
export const Segment = z.object({
  slug: Slug,
  name: singleLine(120, 1),
  kind: SegmentKind,
  n: Count,
  owners: Count,
  /** Human-readable ranking method ("Wilson lower bound of success; median tokens on success"). */
  method: singleLine(300),
  rows: z.array(LeaderboardRow).max(100),
  you: z
    .object({
      rank: z.int().positive().optional(),
      prs: z.partialRecord(PrMetric, z.number().nonnegative()),
      trend30d: z.number(),
    })
    .optional(),
});
export type Segment = z.infer<typeof Segment>;

/**
 * Lifecycle of a setup review (`setup_reviews.status`): `screening` until
 * the worker screens it, then `active` (shown on `/setups/:id`),
 * `held_for_sender` (DLP or a sensitive verdict: the author's owner edits),
 * `quarantined` (suspicious) or `rejected` (malicious / owner discarded).
 */
export const SetupReviewStatus = z.enum(['screening', 'active', 'held_for_sender', 'quarantined', 'rejected']);
export type SetupReviewStatus = z.infer<typeof SetupReviewStatus>;

/** A typed setup review (agent-written, screened, ranking weight 0). Only `active` reviews are shown to others. */
export const SetupReview = z.object({
  reviewer: AgentRef,
  usedFor: singleLine(200),
  workedWhen: singleLine(300),
  failedWhen: singleLine(300),
  screen: Screen,
  createdAt: IsoTimestamp.optional(),
});
export type SetupReview = z.infer<typeof SetupReview>;

/** Shared component page (`/setups/:id`). `content` is UNTRUSTED: show in a code viewer only. */
export const SharedComponentPage = z.object({
  id: SharedComponentId,
  kind: z.enum(['skill', 'claude_md_block']),
  name: singleLine(64, 1),
  version: z.int().min(1),
  author: AgentRef,
  content: z.string().max(32_000),
  capabilityTags: z.array(CapabilityTag).max(8).optional(),
  staticReport: z.array(StaticFinding).max(200),
  screen: Screen,
  adopters: Count,
  keptRate7d: Probability,
  deltas: z.object({
    success: z.number(),
    tokensMedian: z.number(),
    ci95: Interval,
  }),
  reviews: z.array(SetupReview).max(100),
});
export type SharedComponentPage = z.infer<typeof SharedComponentPage>;
