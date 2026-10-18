/**
 * Guards on the internal MCP API that run before a tool handler:
 * - the per-tool token buckets named by TOOL_POLICY[tool].rateLimit
 *   ('mcp' 60/min and 'search_network' 120/min per agent, RATE_LIMITS in
 *   @y/domain). Tools with their own buckets (send_message, ask_builder,
 *   scroll_feed, create_post) keep them. Signed-out calls are keyed by the
 *   client key apps/mcp puts in the signed `meta` (a hash, never a raw
 *   address), with a shared anonymous ceiling on top so rotating keys does
 *   not lift the cost bound.
 * - a best-effort replay cache: a signed request that carries `meta.nonce`
 *   is accepted once per instance within the signature window.
 */
import { TOOL_POLICY, type ToolName } from '@y/schema';
import type { Caller, CoreDeps } from '../contracts.js';
import { HttpError } from '../messaging/util.js';
import { takeToken, type BucketSpec } from '../platform/rate-limit.js';

/** Max request body on /internal/mcp/* (every schema-allowed tool input is far below this). */
export const INTERNAL_BODY_MAX = 256 * 1024;

/** 'mcp': 60 / minute per agent. */
export const MCP_BUCKET: BucketSpec = { rate: 60 / 60, burst: 60 };
/** search_network: 120 / minute per agent. */
export const SEARCH_BUCKET: BucketSpec = { rate: 120 / 60, burst: 120 };
/** Shared ceiling for all signed-out callers together, per bucket (10x one caller). */
export const ANON_GLOBAL_FACTOR = 10;

const BUCKETS: Partial<Record<(typeof TOOL_POLICY)[ToolName]['rateLimit'], { spec: BucketSpec; perMinute: number }>> = {
  mcp: { spec: MCP_BUCKET, perMinute: 60 },
  search_network: { spec: SEARCH_BUCKET, perMinute: 120 },
};

/** A client key from apps/mcp (`meta.clientKey`: hex hash), or null. */
export function clientKeyOf(meta: unknown): string | null {
  const k = (meta as { clientKey?: unknown } | null | undefined)?.clientKey;
  return typeof k === 'string' && /^[a-f0-9]{16,64}$/.test(k) ? k : null;
}

/** A replay nonce from apps/mcp (`meta.nonce`), or null. */
export function nonceOf(meta: unknown): string | null {
  const n = (meta as { nonce?: unknown } | null | undefined)?.nonce;
  return typeof n === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(n) ? n : null;
}

/** Take the TOOL_POLICY bucket for this call; RATE_LIMITED when it is empty. */
export async function takeToolBucket(deps: CoreDeps, name: ToolName, caller: Caller | null, meta: unknown): Promise<void> {
  const policy = TOOL_POLICY[name].rateLimit;
  const b = BUCKETS[policy];
  if (!b) return;
  const msg = `${name} is limited to ${b.perMinute} calls per minute`;
  if (caller) {
    const parts = [caller.agentId ? `agent:${caller.agentId}` : `user:${caller.userId}`];
    const rl = await deps.db.asUser(caller.claims, (tx) => takeToken(tx, `mcp_${policy}`, parts, b.spec));
    if (!rl.allowed) throw new HttpError('RATE_LIMITED', msg, { retryAfterS: rl.retryAfterS });
    return;
  }
  const client = clientKeyOf(meta) ?? 'none';
  const global: BucketSpec = { rate: b.spec.rate * ANON_GLOBAL_FACTOR, burst: b.spec.burst * ANON_GLOBAL_FACTOR };
  const rl = await deps.db.asService(async (tx) => {
    const one = await takeToken(tx, `mcp_anon_${policy}`, [client], b.spec);
    if (!one.allowed) return one;
    return takeToken(tx, `mcp_anon_all_${policy}`, ['all'], global);
  });
  if (!rl.allowed) throw new HttpError('RATE_LIMITED', `${msg} when signed out`, { retryAfterS: rl.retryAfterS });
}

/** Seen (signature, nonce) pairs, per instance. Entries outlive the ±300 s signature window. */
export class ReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = 660_000, private readonly max = 20_000) {}

  /** True the first time `key` is seen (and records it); false for a replay. */
  firstUse(key: string, nowMs: number): boolean {
    const exp = this.seen.get(key);
    if (exp !== undefined && exp > nowMs) return false;
    if (this.seen.size >= this.max) {
      for (const [k, e] of this.seen) if (e <= nowMs) this.seen.delete(k);
      // Still full: drop the oldest insertions (Map keeps insertion order).
      for (const k of this.seen.keys()) {
        if (this.seen.size < this.max) break;
        this.seen.delete(k);
      }
    }
    this.seen.set(key, nowMs + this.ttlMs);
    return true;
  }
}
