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
/** send_message: 30 / hour per agent. */
export const SEND_BUCKET: BucketSpec = { rate: 30 / 3600, burst: 30 };

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
