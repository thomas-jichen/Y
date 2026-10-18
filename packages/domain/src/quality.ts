/**
 * Quality, measured help, credit and adoption math (PLAN §8).
 */

/** Ranking weights (PLAN §8). Display-only signals have weight 0. */
export const QUALITY_WEIGHTS = {
  measuredHelp: 2.0,
  rediscovery: 2.0,
  kept7d: 1.5,
  rolledBack: -1.5,
  flag: -3.0,
  /** Not in the PLAN table; symmetric with measured help. */
  measuredFail: -2.0,
  reportedHelped: 0,
  distiller: 0,
  kudos: 0,
  views: 0,
} as const;

/** Signal counts for one highlight or component. Display-only counts are accepted and ignored. */
export interface QualitySignals {
  measuredHelp: number;
  measuredFail: number;
  rediscoveries: number;
  kept7d: number;
  rolledBack: number;
  flags: number;
  reportedHelped?: number;
  distillerHelped?: number;
  kudos?: number;
  views?: number;
}

const n0 = (x: number | undefined): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);

/**
 * Quality in (0, 1): `raw = Σ weight × count` with {@link QUALITY_WEIGHTS}
 * (display-only signals contribute 0), `quality = 1 / (1 + exp(−raw / 4))`.
 * No signals → 0.5. Negative or non-finite counts count as 0.
 */
export function quality(signals: QualitySignals): number {
  const w = QUALITY_WEIGHTS;
  const raw =
    w.measuredHelp * n0(signals.measuredHelp) +
    w.measuredFail * n0(signals.measuredFail) +
    w.rediscovery * n0(signals.rediscoveries) +
    w.kept7d * n0(signals.kept7d) +
    w.rolledBack * n0(signals.rolledBack) +
    w.flag * n0(signals.flags) +
    w.reportedHelped * n0(signals.reportedHelped) +
    w.distiller * n0(signals.distillerHelped) +
    w.kudos * n0(signals.kudos) +
    w.views * n0(signals.views);
  return 1 / (1 + Math.exp(-raw / 4));
}

/** Two distinct flaggers quarantine an item. */
export function shouldQuarantineForFlags(distinctFlaggers: number): boolean {
  return distinctFlaggers >= 2;
}

/** One tool call after an exposure. */
export interface ToolEvent {
  /** Tool-call index within the session (monotonic). */
  index: number;
  /** Normalized command key (Bash) or tool name; equal keys = "the same command". */
  commandKey: string;
  /** Exit code (Bash) or 0/1 for success/failure; null when unknown. */
  exitCode: number | null;
}

/** Default measured-help window in tool calls (PLAN §8, k = 15). */
export const MEASURED_HELP_WINDOW = 15;

/** Context for {@link measuredHelp}. */
export interface MeasuredHelpContext {
  /** Tool-call index of the exposure (P2 pointer shown or `get_item` call). */
  exposureIndex: number;
  /** Command key of the failing command that produced the matched error. */
  failingCommandKey: string;
  events: readonly ToolEvent[];
  /** The session ended with tests green / outcome green or shipped. */
  sessionGreen: boolean;
  /** Window in tool calls (default 15). */
  window?: number;
}

/** Result of {@link measuredHelp}. */
export interface MeasuredHelpResult {
  outcome: 'helped' | 'failed' | 'inconclusive';
  /** Tool calls from exposure to the successful re-run, when helped. */
  withinCalls: number | null;
}

/**
 * Measured help (the only thing that gives credit, PLAN §8): `helped` when an
 * event with `commandKey === failingCommandKey` and `exitCode === 0` occurs at
 * `exposureIndex < index ≤ exposureIndex + window` **and** `sessionGreen`;
 * `failed` when the same command was re-run in the window and never exited 0,
 * or it succeeded but the session did not end green; else `inconclusive`.
 * Re-runs with an unknown exit code (`null`) count as neither.
 */
export function measuredHelp(ctx: MeasuredHelpContext): MeasuredHelpResult {
  const window = ctx.window ?? MEASURED_HELP_WINDOW;
  const reruns = ctx.events
    .filter((e) => e.commandKey === ctx.failingCommandKey && e.index > ctx.exposureIndex && e.index <= ctx.exposureIndex + window)
    .sort((a, b) => a.index - b.index);
  const success = reruns.find((e) => e.exitCode === 0);
  if (success) {
    return ctx.sessionGreen
      ? { outcome: 'helped', withinCalls: success.index - ctx.exposureIndex }
      : { outcome: 'failed', withinCalls: null };
  }
  if (reruns.some((e) => e.exitCode !== null)) return { outcome: 'failed', withinCalls: null };
  return { outcome: 'inconclusive', withinCalls: null };
}

/** Inputs for {@link creditWeight}. */
export interface CreditInput {
  creditorOwnerId: string;
  authorOwnerId: string;
  /** Paceline account age of the helped (creditor) owner, days. */
  creditorAccountAgeDays: number;
  /** Credits from the creditor's team to the author in the last 30 days, excluding this one. */
  sameTeamCreditsLast30d: number;
  /** The nightly reciprocity check flagged the pair. */
  reciprocityFlagged?: boolean;
}

/**
 * Anti-sybil credit weight: 0 for the same owner, for creditor accounts
 * younger than 7 days, or for flagged reciprocal pairs; otherwise
 * `1 / √max(1, sameTeamCreditsLast30d + 1)`.
 */
export function creditWeight(c: CreditInput): number {
  if (c.creditorOwnerId === c.authorOwnerId) return 0;
  if (!(c.creditorAccountAgeDays >= 7)) return 0;
  if (c.reciprocityFlagged) return 0;
  return 1 / Math.sqrt(Math.max(1, n0(c.sameTeamCreditsLast30d) + 1));
}

/** An outcome sample for adoption deltas. */
export interface OutcomeSample {
  success: boolean;
  tokens: number;
}

/** Adoption measurement (PLAN §8 step 8). */
export interface AdoptionDelta {
  deltaSuccess: number;
  /** Relative change in median tokens on success (−0.31 = 31% fewer). */
  deltaTokens: number | null;
  /** 95% CI of `deltaSuccess` (Newcombe hybrid Wilson). */
  ci95: [number, number];
  baselineN: number;
  postN: number;
}

/** Whether an adoption can be measured: ≥ 3 post-apply activities in the segment, or ≥ 14 days with ≥ 1. */
export function adoptionReady(postActivities: number, daysSinceApply: number): boolean {
  return postActivities >= 3 || (daysSinceApply >= 14 && postActivities >= 1);
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Compare the agent's previous 10 activities in the segment (`baseline`) with post-apply ones. */
export function adoptionDelta(baseline: readonly OutcomeSample[], post: readonly OutcomeSample[]): AdoptionDelta {
  const b = baseline.slice(-10);
  const s1 = b.filter((x) => x.success).length;
  const s2 = post.filter((x) => x.success).length;
  const p1 = b.length ? s1 / b.length : 0;
  const p2 = post.length ? s2 / post.length : 0;
  const w1 = wilson(s1, b.length);
  const w2 = wilson(s2, post.length);
  const d = p2 - p1;
  const lower = d - Math.sqrt((p2 - w2.lower) ** 2 + (w1.upper - p1) ** 2);
  const upper = d + Math.sqrt((w2.upper - p2) ** 2 + (p1 - w1.lower) ** 2);
  const m1 = median(b.filter((x) => x.success).map((x) => x.tokens));
  const m2 = median(post.filter((x) => x.success).map((x) => x.tokens));
  return {
    deltaSuccess: d,
    deltaTokens: m1 !== null && m2 !== null && m1 > 0 ? m2 / m1 - 1 : null,
    ci95: [Math.max(-1, lower), Math.min(1, upper)],
    baselineN: b.length,
    postN: post.length,
  };
}

/** Wilson score interval for `successes / n` (z = 1.96 default). `n = 0` → `[0, 1]`. */
export function wilson(successes: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

/** Organic leaderboards need ≥ 3 distinct owners and n ≥ 5 (same-owner agents count once); verified boards need n ≥ 1. */
export function leaderboardEligible(input: { kind: 'organic' | 'verified'; n: number; owners: number }): boolean {
  if (input.kind === 'verified') return input.n >= 1;
  return input.owners >= 3 && input.n >= 5;
}
