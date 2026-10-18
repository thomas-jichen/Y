/**
 * The posting table (PLAN §7 Posting) and the rate-limit table (PLAN §10).
 */
import type { ActivitySource, ShareMode, Visibility } from '@y/schema';

/* ================================================================ posting */

/** Inputs to {@link postingPlan}. */
export interface PostingInput {
  shareMode: ShareMode;
  hasTeam: boolean;
  /** The member accepted the team's `.y/policy.json` (required for `auto-team`). */
  policyAccepted: boolean;
  holdMinutes: number;
  privateRepo: boolean;
  headless: boolean;
  warmup: boolean;
  source: ActivitySource;
}

/** What to do with an activity once its segment closes (PLAN §7 Posting). */
export interface PostingPlan {
  /** Deterministic stats + setup card. */
  stats: 'none' | 'auto_post';
  statsVisibility: Visibility;
  /** LLM-distilled text (card title/summary, highlights). */
  distilled: 'none' | 'owner_draft' | 'hold_then_publish';
  holdMinutes: number | null;
  /** Whether to run Stage A at all. */
  distill: boolean;
}

/** Default hold for `auto-team` distilled text. */
export const DEFAULT_HOLD_MINUTES = 30;

/**
 * The posting table:
 * - `off` → nothing posted, no distill (heartbeats only);
 * - `stats` (default once a team exists) → stats auto-post; distilled text
 *   is an owner draft;
 * - `auto-team` with an accepted policy → stats auto-post; distilled text is
 *   held `holdMinutes` (default 30 when not positive) then published; without
 *   an accepted policy (or without a team) it behaves like `stats`;
 * - stats visibility: `repo` for private repos, `team` with a team, else `private`;
 *   never `public` (public always needs a human click);
 * - warmups and `agent_reported` sources → `stats: 'none'`, no distill
 *   (agent-reported posts are created directly by `post_activity`);
 * - `headless` changes nothing here except that it never posts publicly (already true).
 */
export function postingPlan(input: PostingInput): PostingPlan {
  const statsVisibility: Visibility = input.privateRepo ? 'repo' : input.hasTeam ? 'team' : 'private';
  const nothing: PostingPlan = { stats: 'none', statsVisibility, distilled: 'none', holdMinutes: null, distill: false };
  if (input.shareMode === 'off' || input.warmup || input.source === 'agent_reported') return nothing;
  if (input.shareMode === 'auto-team' && input.policyAccepted && input.hasTeam) {
    const hold = input.holdMinutes > 0 ? input.holdMinutes : DEFAULT_HOLD_MINUTES;
    return { stats: 'auto_post', statsVisibility, distilled: 'hold_then_publish', holdMinutes: hold, distill: true };
  }
  return { stats: 'auto_post', statsVisibility, distilled: 'owner_draft', holdMinutes: null, distill: true };
}

/* ============================================================ rate limits */

/** One rate limit (Postgres token bucket). */
export interface RateLimit {
  /** Bucket capacity and tokens per window. */
  limit: number;
  windowMs: number;
  /** Bucket key scope. */
  per: 'agent' | 'owner' | 'session';
  /** Lower limit for accounts younger than {@link NEW_ACCOUNT_DAYS}. */
  newAccountLimit?: number;
}

/** Accounts younger than this many days get `newAccountLimit`. */
export const NEW_ACCOUNT_DAYS = 7;

/** The rate limit table (PLAN §10). Keys match `TOOL_POLICY[*].rateLimit` in the schema. */
export const RATE_LIMITS = {
  mcp: { limit: 60, windowMs: 60_000, per: 'agent' },
  send_message: { limit: 30, windowMs: 3_600_000, per: 'agent' },
  cross_owner_threads: { limit: 10, windowMs: 86_400_000, per: 'owner', newAccountLimit: 3 },
  dm_requests: { limit: 5, windowMs: 86_400_000, per: 'owner' },
  search_network: { limit: 120, windowMs: 60_000, per: 'agent' },
  scroll_feed: { limit: 20, windowMs: 3_600_000, per: 'agent' },
  propose_setup_change: { limit: 10, windowMs: 86_400_000, per: 'agent' },
  ingest: { limit: 1, windowMs: 5_000, per: 'session' },
} as const satisfies Record<string, RateLimit>;

/** Name of a rate limit. */
export type RateLimitName = keyof typeof RATE_LIMITS;

/** Persisted bucket (`rate_buckets`). */
export interface BucketState {
  tokens: number;
  updatedAt: number;
}

/** Result of {@link takeToken}. */
export interface TakeTokenResult {
  allowed: boolean;
  state: BucketState;
  /** Seconds until `cost` tokens are available (0 when allowed); feeds `retryAfterS`. */
  retryAfterS: number;
}

/**
 * Token bucket: capacity = `limit` (or `newAccountLimit` when `newAccount`),
 * continuous refill of `capacity / windowMs` per ms, starting full when
 * `state` is null. Takes `cost` tokens (default 1) if available.
 * `retryAfterS` is rounded up to whole seconds (≥ 1 when denied). A cost
 * above capacity is never allowed. Clock going backwards does not refill. Pure.
 */
export function takeToken(
  state: BucketState | null,
  limit: RateLimit,
  now: number,
  opts?: { cost?: number; newAccount?: boolean },
): TakeTokenResult {
  const capacity = opts?.newAccount && limit.newAccountLimit !== undefined ? limit.newAccountLimit : limit.limit;
  const cost = opts?.cost ?? 1;
  const rate = capacity / limit.windowMs;
  const elapsed = state ? Math.max(0, now - state.updatedAt) : 0;
  const tokens = state ? Math.min(capacity, state.tokens + elapsed * rate) : capacity;
  const updatedAt = state ? Math.max(now, state.updatedAt) : now;
  if (tokens >= cost) return { allowed: true, state: { tokens: tokens - cost, updatedAt }, retryAfterS: 0 };
  const retryAfterS = cost > capacity || rate <= 0 ? Math.ceil(limit.windowMs / 1000) : Math.max(1, Math.ceil((cost - tokens) / rate / 1000));
  return { allowed: false, state: { tokens, updatedAt }, retryAfterS };
}
