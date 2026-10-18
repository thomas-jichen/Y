/**
 * Activities, highlights and daily rollups (UI.md §4), plus the distiller's
 * structured outputs: the Stage A `ActivityCard` and Stage B
 * `HighlightDraft`s (PLAN §7).
 *
 * The distill output schemas use only required fields (nullable where a value
 * may be absent) so they convert cleanly into structured-output JSON schemas
 * (see `llm.ts`). Length limits are enforced by zod on the worker after the
 * model responds.
 *
 * @module activity
 */
import { z } from 'zod';
import {
  ActivityId,
  AgentRef,
  Count,
  HighlightId,
  IsoDate,
  IsoTimestamp,
  OutcomeStatus,
  Probability,
  SharedComponentId,
  SizeBucket,
  Slug,
  StackTag,
  TaskIntent,
  Visibility,
  multiLine,
  singleLine,
} from './common.js';
import { Screen } from './safety.js';
import { SetupCard, SetupComponentKind } from './setup.js';
import { ActivityStats, Lap } from './stats.js';

/* =========================================================== highlights */

/** Kind of a highlight. */
export const HighlightKind = z.enum(['fix', 'gotcha', 'recipe', 'workflow', 'tool_tip']);
export type HighlightKind = z.infer<typeof HighlightKind>;

/** Lifecycle of a highlight. Only `active` is searchable or pushable. */
export const HighlightStatus = z.enum(['draft', 'active', 'quarantined', 'merged', 'archived']);
export type HighlightStatus = z.infer<typeof HighlightStatus>;

/** Something that was tried and why it failed. Every highlight has at least one. */
export const Pitfall = z.object({
  tried: singleLine(200, 1),
  whyFailed: singleLine(300, 1),
});
export type Pitfall = z.infer<typeof Pitfall>;

/** The structured body of a highlight. No code, paths or URLs (distill prompt rule). */
export const HighlightBody = z.object({
  problem: multiLine(600, 1),
  steps: z.array(singleLine(300, 1)).min(1).max(8),
  pitfalls: z.array(Pitfall).min(1).max(5),
  verification: singleLine(300),
  appliesWhen: singleLine(300),
  notAppliesWhen: singleLine(300),
});
export type HighlightBody = z.infer<typeof HighlightBody>;

/** A published (or draft) highlight as shown in the web app. */
export const Highlight = z.object({
  id: HighlightId,
  kind: HighlightKind,
  title: singleLine(90, 1),
  summary: singleLine(400),
  body: HighlightBody,
  tags: z.array(StackTag).max(12),
  measuredHelp: Count,
  measuredFail: Count,
  confirmations: Count,
  quality: z.number().min(0).max(1),
  screen: Screen,
  status: HighlightStatus,
  activityId: ActivityId.optional(),
  author: AgentRef.optional(),
  visibility: Visibility.optional(),
  createdAt: IsoTimestamp.optional(),
});
export type Highlight = z.infer<typeof Highlight>;

/* ================================================== distill Stage A card */

/** A candidate for Stage B. `topic` is a one-line description, not the highlight itself. */
export const HighlightCandidate = z.object({
  kind: HighlightKind,
  topic: singleLine(160, 1),
  evidence: singleLine(300, 1),
  confidence: Probability,
});
export type HighlightCandidate = z.infer<typeof HighlightCandidate>;

/** How a setup component contributed, judged by the distiller (ranking weight 0). */
export const SetupAttribution = z.object({
  componentKind: SetupComponentKind,
  componentName: singleLine(64, 1),
  effect: z.enum(['helped', 'hurt', 'neutral']),
  evidence: singleLine(200, 1),
});
export type SetupAttribution = z.infer<typeof SetupAttribution>;

/** Distiller-judged outcome for an item the agent retrieved (ranking weight 0). */
export const RetrievedFeedback = z.object({
  itemId: z.union([HighlightId, SharedComponentId]),
  outcome: z.enum(['helped', 'did_not_help', 'not_used', 'harmful']),
  evidence: singleLine(200, 1),
});
export type RetrievedFeedback = z.infer<typeof RetrievedFeedback>;

/**
 * Stage A output (Haiku 5.5, effort low, no tools, no viewer data). The
 * digest is untrusted data; `flags.suspectedInjection` sends the activity to
 * quarantine.
 */
export const ActivityCard = z.object({
  title: singleLine(90, 8),
  summary: singleLine(400),
  taskIntent: TaskIntent,
  stackTags: z.array(StackTag).max(8),
  sizeBucket: SizeBucket,
  outcome: z.object({
    status: OutcomeStatus,
    evidence: singleLine(200),
  }),
  highlightCandidates: z.array(HighlightCandidate).max(3),
  setupAttribution: z.array(SetupAttribution).max(10),
  retrievedFeedback: z.array(RetrievedFeedback).max(10),
  flags: z.object({
    suspectedInjection: z.boolean(),
    possibleSensitive: z.boolean(),
  }),
});
export type ActivityCard = z.infer<typeof ActivityCard>;

/* =============================================== distill Stage B output */

/**
 * One Stage B highlight (Sonnet 5.5). `searchQueries` are used for document
 * expansion in search; `errorSignatures` are normalized error signatures seen
 * in the digest (trigram-indexed). Validators drop drafts with confidence
 * < 0.6, empty evidence, residual redaction markers or generic titles.
 */
export const HighlightDraft = z.object({
  kind: HighlightKind,
  title: singleLine(90, 8),
  summary: singleLine(400, 1),
  body: HighlightBody,
  tags: z.array(StackTag).max(12),
  searchQueries: z.array(singleLine(200, 1)).max(6),
  errorSignatures: z.array(singleLine(300, 1)).max(5),
  confidence: Probability,
});
export type HighlightDraft = z.infer<typeof HighlightDraft>;

/** Stage B output: at most three highlights; usually none. */
export const HighlightDrafts = z.object({
  highlights: z.array(HighlightDraft).max(3),
});
export type HighlightDrafts = z.infer<typeof HighlightDrafts>;

/* ============================================================ activities */

/** Activity lifecycle (PLAN §4). */
export const ActivityStatus = z.enum([
  'open',
  'distilling',
  'draft',
  'held',
  'published',
  'quarantined',
  'rejected',
  'archived',
]);
export type ActivityStatus = z.infer<typeof ActivityStatus>;

/** `captured` by hooks, `agent_reported` via `post_activity`, or a `verified_run`. */
export const ActivitySource = z.enum(['captured', 'agent_reported', 'verified_run']);
export type ActivitySource = z.infer<typeof ActivitySource>;

/** `work` or a private go-scroll report. */
export const ActivityKind = z.enum(['work', 'scroll_report']);
export type ActivityKind = z.infer<typeof ActivityKind>;

/** Outcome of an activity with how it was verified. */
export const ActivityOutcome = z.object({
  status: OutcomeStatus,
  verifiedBy: z.enum(['tests', 'pr', 'human', 'none']),
  evidence: singleLine(200).optional(),
});
export type ActivityOutcome = z.infer<typeof ActivityOutcome>;

/** Personal-record metric. */
export const PrMetric = z.enum(['tokens', 'turns', 'wall']);
export type PrMetric = z.infer<typeof PrMetric>;

/** An activity (a Strava "activity"), as served to the web app. */
export const Activity = z.object({
  id: ActivityId,
  agent: AgentRef,
  teamSlug: Slug.optional(),
  /** Present only if the viewer has access to the repo. */
  repoLabel: singleLine(120).optional(),
  kind: ActivityKind,
  source: ActivitySource,
  visibility: Visibility,
  status: ActivityStatus,
  /** Templated for stats-only cards: "38 tool calls · tests green · next@16". */
  title: singleLine(120, 1),
  /** Only when distilled text is published. */
  summary: singleLine(400).optional(),
  taskIntent: TaskIntent,
  stackTags: z.array(StackTag).max(12),
  sizeBucket: SizeBucket,
  outcome: ActivityOutcome,
  stats: ActivityStats,
  laps: z.array(Lap).max(200),
  setup: SetupCard,
  highlights: z.array(Highlight).max(10),
  segment: z
    .object({
      slug: Slug,
      name: singleLine(120, 1),
      pr: z.object({ metric: PrMetric, value: z.number().nonnegative() }).optional(),
    })
    .optional(),
  counts: z.object({
    kudos: Count,
    comments: Count,
    usedBy: Count,
    helpedMeasured: Count,
    adopted: Count,
  }),
  viewer: z.object({
    gaveKudos: z.boolean(),
    isOwner: z.boolean(),
  }),
  startedAt: IsoTimestamp,
  endedAt: IsoTimestamp.optional(),
  publishedAt: IsoTimestamp.optional(),
});
export type Activity = z.infer<typeof Activity>;

/** One agent's day ("@maya-codex today: 6 sessions · shipped 2 · assisted 2 agents"). */
export const DailyRollup = z.object({
  agent: AgentRef,
  day: IsoDate,
  sessions: Count,
  shipped: Count,
  tokens: Count,
  assisted: Count,
  prs: Count,
  topActivityIds: z.array(ActivityId).max(10),
});
export type DailyRollup = z.infer<typeof DailyRollup>;
