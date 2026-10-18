/**
 * Guards on the internal MCP API that run before a tool handler:
 * - the per-tool token buckets named by TOOL_POLICY[tool].rateLimit
 *   ('mcp' and 'search_network', MCP_PER_MINUTE / SEARCH_PER_MINUTE per
 *   agent). These sit above the 60/min and 120/min of RATE_LIMITS in
 *   @y/domain on purpose: the agent is the install token, so every
 *   session and subagent on one machine shares the bucket, and the server
 *   instructions ask for status, inbox and report_outcome often. They are a
 *   flood bound, not a per-session budget. Tools with their own buckets
 *   (send_message, ask_builder, scroll_feed, create_post) keep them.
 *   Signed-out calls are keyed by the client key apps/mcp puts in the
 *   signed `meta` (a hash of the address, never the address itself) when
 *   it came from a trusted client-IP header (`clientKeySource` 'header', or
 *   no source from an older sender). A key from the rightmost
 *   X-Forwarded-For hop ('forwarded_for') may be one proxy shared by every
 *   caller, so those calls, and calls without a key, share one bucket at
 *   ANON_SHARED_FACTOR times the limit; hitting it is logged.
 * - a best-effort replay cache: a signed request that carries `meta.nonce`
 *   (inside the signed body) is accepted once per instance within the
 *   signature window.
 */
import { TOOL_POLICY, type ToolName } from '@y/schema';
import type { Caller, CoreDeps } from '../contracts.js';
import { HttpError } from '../messaging/util.js';
import { takeToken, type BucketSpec } from '../platform/rate-limit.js';

/** Max request body on /internal/mcp/* (every schema-allowed tool input is far below this). */
export const INTERNAL_BODY_MAX = 256 * 1024;

/** 'mcp' calls per minute per agent (or per trusted signed-out client). */
export const MCP_PER_MINUTE = 300;
/** search_network calls per minute per agent (or per trusted signed-out client). */
export const SEARCH_PER_MINUTE = 300;
/** 'mcp': MCP_PER_MINUTE per agent. */
export const MCP_BUCKET: BucketSpec = { rate: MCP_PER_MINUTE / 60, burst: MCP_PER_MINUTE };
/** search_network: SEARCH_PER_MINUTE per agent. */
export const SEARCH_BUCKET: BucketSpec = { rate: SEARCH_PER_MINUTE / 60, burst: SEARCH_PER_MINUTE };
/**
 * Signed-out calls without a trusted client key (local dev, a proxy that
 * forwards no address, or an address from X-Forwarded-For only) share one
 * bucket at this multiple of the per-client limit. Calls with a trusted
 * client key only take their own bucket, so no caller can drain a limit
 * that other signed-out users depend on.
 */
export const ANON_SHARED_FACTOR = 10;

const BUCKETS: Partial<Record<(typeof TOOL_POLICY)[ToolName]['rateLimit'], { spec: BucketSpec; perMinute: number }>> = {
  mcp: { spec: MCP_BUCKET, perMinute: MCP_PER_MINUTE },
  search_network: { spec: SEARCH_BUCKET, perMinute: SEARCH_PER_MINUTE },
};

/** A client key from apps/mcp (`meta.clientKey`: hex hash), or null. */
export function clientKeyOf(meta: unknown): string | null {
  const k = (meta as { clientKey?: unknown } | null | undefined)?.clientKey;
  return typeof k === 'string' && /^[a-f0-9]{16,64}$/.test(k) ? k : null;
}

/**
 * The client key to give its own signed-out bucket, or null. A key whose
 * `meta.clientKeySource` is 'forwarded_for' (the rightmost X-Forwarded-For
 * hop, possibly a proxy every caller shares) is not one: those calls take
 * the shared bucket. 'header' and an absent source keep their own bucket.
 */
export function trustedClientKeyOf(meta: unknown): string | null {
  const src = (meta as { clientKeySource?: unknown } | null | undefined)?.clientKeySource;
  if (src !== undefined && src !== 'header') return null;
  return clientKeyOf(meta);
}

/**
 * True when compare_setups must leave out names that are not ComponentName:
 * the request carries meta (it came from an apps/mcp) without
 * `wideSetupNames`, so it is a build from before SetupSignalName and would
 * reject the whole result on a `model:...[1m]` or long plugin@marketplace
 * name. Requests without meta keep the current contract.
 */
export function legacySetupNames(meta: unknown): boolean {
  return typeof meta === 'object' && meta !== null && (meta as { wideSetupNames?: unknown }).wideSetupNames !== true;
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
  const client = trustedClientKeyOf(meta);
  if (client) {
    const rl = await deps.db.asService((tx) => takeToken(tx, `mcp_anon_${policy}`, [client], b.spec));
    if (!rl.allowed) throw new HttpError('RATE_LIMITED', `${msg} when signed out`, { retryAfterS: rl.retryAfterS });
    return;
  }
  const shared: BucketSpec = { rate: b.spec.rate * ANON_SHARED_FACTOR, burst: b.spec.burst * ANON_SHARED_FACTOR };
  const rl = await deps.db.asService((tx) => takeToken(tx, `mcp_anon_shared_${policy}`, ['none'], shared));
  if (!rl.allowed) {
    deps.log('warn', 'signed-out MCP calls without a client key hit the shared limit', {
      tool: name, bucket: policy, keyed: clientKeyOf(meta) ? 'forwarded_for' : 'none',
    });
    throw new HttpError('RATE_LIMITED', `${msg} when signed out`, { retryAfterS: rl.retryAfterS });
  }
}

/**
 * Seen request nonces, per instance. Entries outlive the ±300 s signature
 * window. Keyed on the nonce alone: it is inside the signed body, so the
 * header's spelling (e.g. a zero-padded `t=`) cannot make a replay look new.
 */
export class ReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = 660_000, private readonly max = 100_000) {}

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
