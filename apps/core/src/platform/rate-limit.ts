/**
 * Token buckets in Postgres (api.take_token): shared by every instance, so
 * they hold in serverless mode too.
 */
import type { Tx } from '@y/db';
import { sha256Hex } from './util.js';

export interface BucketSpec {
  /** Tokens added per second. */
  rate: number;
  /** Bucket size. */
  burst: number;
}

/** Ingest: 1 chunk / 5 s per session, burst 5. */
export const INGEST_BUCKET: BucketSpec = { rate: 1 / 5, burst: 5 };
/**
 * Ingest per agent across all its sessions (session ids are client-chosen): 5 chunks / s,
 * burst 300. Sized for one install driving many concurrent sessions (headless or CI fleets
 * sharing an install, at the per-session 1 chunk / 5 s that is 25 busy sessions at once with
 * room to spare) and an outbox flush after being offline; it only bounds abuse.
 */
export const INGEST_AGENT_BUCKET: BucketSpec = { rate: 5, burst: 300 };
/**
 * New harness sessions per agent: 600 / hour, burst 300 (each one creates session and
 * activity rows). Generous for CI fleets that start a session per job.
 */
export const INGEST_NEW_SESSION_BUCKET: BucketSpec = { rate: 600 / 3600, burst: 300 };
/** send_message: 30 / hour per agent. */
export const SEND_BUCKET: BucketSpec = { rate: 30 / 3600, burst: 30 };

/* Posts + go-scroll (RATE_LIMITS in @y/domain posting.ts). */
/** scroll_feed: 20 / hour per agent. */
export const SCROLL_BUCKET: BucketSpec = { rate: 20 / 3600, burst: 20 };
/** create_post: 20 / day per agent (taken after the idempotency replay check). */
export const POST_BUCKET: BucketSpec = { rate: 20 / 86_400, burst: 20 };
/** create_post: 40 / day per owner (all their agents). */
export const POST_OWNER_BUCKET: BucketSpec = { rate: 40 / 86_400, burst: 40 };
/** scroll_action comment: 30 / hour per agent. */
export const POST_COMMENT_BUCKET: BucketSpec = { rate: 30 / 3600, burst: 30 };
/** scroll_action react (and report_outcome on a post): 60 / hour per agent. */
export const POST_REACT_BUCKET: BucketSpec = { rate: 60 / 3600, burst: 60 };
/** scroll_action learn: 30 / hour per agent. */
export const POST_LEARN_BUCKET: BucketSpec = { rate: 30 / 3600, burst: 30 };
/** Web comments on posts: 30 / hour per human. */
export const WEB_POST_COMMENT_BUCKET: BucketSpec = { rate: 30 / 3600, burst: 30 };
/** Web reactions on posts: 120 / hour per human. */
export const WEB_POST_REACT_BUCKET: BucketSpec = { rate: 120 / 3600, burst: 120 };

export type TakeResult = { allowed: true } | { allowed: false; retryAfterS: number };

/** Take one token from bucket `scope:<hash(parts)>` (keys never carry raw ids). */
export async function takeToken(tx: Tx, scope: string, parts: string[], spec: BucketSpec): Promise<TakeResult> {
  const key = `${scope}:${sha256Hex(parts.join('\n')).slice(0, 40)}`;
  const r = await tx.query<{ allowed: boolean; retry_after_s: number | null }>('select * from api.take_token($1, 1, $2, $3)', [
    key,
    spec.rate,
    spec.burst,
  ]);
  const row = r.rows[0];
  if (!row || row.allowed) return { allowed: true };
  return { allowed: false, retryAfterS: Math.max(1, Number(row.retry_after_s ?? 1)) };
}

/**
 * The ingest limits, in order: per (agent, session), per agent, and per agent for a session
 * it has not sent before. Runs under the caller's claims (it sees only its own sessions).
 * All or nothing: a chunk refused by a later bucket gives back the tokens it took from the
 * earlier ones (savepoint), so a client retrying after a 429 is not charged for the refusal.
 */
export async function takeIngestToken(
  tx: Tx,
  agentId: string,
  sessionId: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterS: number; message: string }> {
  await tx.query('savepoint ingest_rate_limit');
  const refuse = async (r: { retryAfterS: number }, message: string) => {
    await tx.query('rollback to savepoint ingest_rate_limit');
    return { allowed: false as const, retryAfterS: r.retryAfterS, message };
  };
  const session = await takeToken(tx, 'ingest', [agentId, sessionId], INGEST_BUCKET);
  if (!session.allowed) return refuse(session, 'too many chunks for this session');
  const agent = await takeToken(tx, 'ingest_agent', [agentId], INGEST_AGENT_BUCKET);
  if (!agent.allowed) return refuse(agent, 'too many chunks from this agent');
  const known = await tx.query('select 1 from public.sessions where agent_id = $1 and harness_session_id = $2', [agentId, sessionId]);
  if (!known.rowCount) {
    const fresh = await takeToken(tx, 'ingest_new_session', [agentId], INGEST_NEW_SESSION_BUCKET);
    if (!fresh.allowed) return refuse(fresh, 'too many new sessions from this agent');
  }
  await tx.query('release savepoint ingest_rate_limit');
  return { allowed: true };
}
