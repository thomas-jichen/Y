/**
 * AuthService: install tokens (`pcl_agt_…`), dev web sessions (`pcl_web_…`),
 * pulse tokens (`pcl_pls_…`, short-lived, HMAC-signed), Supabase JWTs (JWKS),
 * and the apps/mcp → core internal HMAC (`X-Y-Internal`).
 */
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Db } from '@y/db';
import {
  INTERNAL_SIGNATURE_MAX_SKEW_S,
  internalSigningString,
  parseInternalSignatureHeader,
} from '@y/schema';
import type { AuthService, Caller, CoreConfig } from '../contracts.js';
import {
  INSTALL_TOKEN_PREFIX,
  PULSE_TOKEN_PREFIX,
  STREAM_TOKEN_PREFIX,
  WEB_TOKEN_PREFIX,
  hmacHex,
  safeEqual,
  sha256Hex,
} from './util.js';

const CACHE_MS = 60_000;
/** Most entries per auth cache; a full cache is cleared, so random tokens can't grow memory. */
export const AUTH_CACHE_MAX = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PULSE_TOKEN_TTL_S = 3600;
/** EventSource can't send headers: GET /api/v1/stream?token=<this>, valid 60 s. */
export const STREAM_TOKEN_TTL_S = 60;
/** Step-up window (I5): review decisions and owner instructions need a web login newer than this. */
export const STEP_UP_MAX_AGE_S = 12 * 3600;

export interface PlatformAuthOptions {
  /** Override the Supabase key set (tests: jose createLocalJWKSet). */
  jwks?: JWTVerifyGetKey;
  /** Override {@link AUTH_CACHE_MAX} (tests). */
  cacheMax?: number;
}

type Cached<T> = { at: number; value: T };

/** Set with a size bound: a full cache starts over (amortised O(1); live tokens just re-resolve). */
function setBounded<T>(map: Map<string, Cached<T>>, key: string, value: Cached<T>, max: number): void {
  if (!map.has(key) && map.size >= max) map.clear();
  map.set(key, value);
}

/** Latest authentication time in a Supabase access token: `amr[].timestamp`, else `auth_time`. */
export function supabaseAuthTime(payload: JWTPayload): number | null {
  const amr = (payload as { amr?: unknown }).amr;
  let best: number | null = null;
  if (Array.isArray(amr)) {
    for (const m of amr) {
      const t = (m as { timestamp?: unknown } | null)?.timestamp;
      if (typeof t === 'number' && Number.isFinite(t)) best = best === null ? t : Math.max(best, t);
    }
  }
  if (best !== null) return best;
  const at = (payload as { auth_time?: unknown }).auth_time;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

export type InstallResolution =
  | { state: 'ok'; caller: Caller; handle: string; harness: string }
  | { state: 'revoked' | 'unknown_install' };

interface InstallRow {
  install_id: string;
  agent_id: string;
  owner_user_id: string;
  agent_handle: string;
  harness: string;
  revoked: boolean;
  agent_status: string;
  user_status: string;
}

export function installCaller(userId: string, agentId: string, installId: string): Caller {
  return {
    userId,
    agentId,
    installId,
    via: 'install',
    claims: { sub: userId, agent_id: agentId, install_id: installId, via: 'install' },
  };
}

export function webCaller(userId: string, via: 'web' | 'dev', authTime: number | null = null): Caller {
  // claims.via is 'web' for both: is_human() keys on it (dev sessions are human web sessions).
  return { userId, agentId: null, installId: null, via, claims: { sub: userId, via: 'web' }, authTime };
}

export class PlatformAuth implements AuthService {
  private readonly installCache = new Map<string, Cached<InstallResolution>>();
  private readonly webCache = new Map<string, Cached<Caller | null>>();
  /** Pulse tokens: is install i a live install of agent a owned by user u? Keyed `i:a:u`. */
  private readonly pulseCache = new Map<string, Cached<boolean>>();
  /** Supabase users: is public.users.status 'active'? Keyed by sub. */
  private readonly jwtStatusCache = new Map<string, Cached<boolean>>();
  private readonly cacheMax: number;
  private readonly provisioned = new Set<string>();
  private readonly jwks: JWTVerifyGetKey | null;
  private readonly hsKey: Uint8Array | null;
  private readonly pulseKey: string;
  private readonly streamKey: string;

  constructor(
    private readonly config: CoreConfig,
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
    opts: PlatformAuthOptions = {},
  ) {
    this.jwks = opts.jwks ?? (config.supabase.jwksUrl ? createRemoteJWKSet(new URL(config.supabase.jwksUrl)) : null);
    this.hsKey = config.supabase.jwtSecret ? new TextEncoder().encode(config.supabase.jwtSecret) : null;
    // Core-only key material: apps/mcp holds Y_INTERNAL_SECRET (to sign forwarded
    // calls) but never Y_HMAC_KEY, so it cannot mint pulse or stream tokens.
    this.pulseKey = `y-pulse-v2\n${config.hmacKey}`;
    this.streamKey = `y-stream-v2\n${config.hmacKey}`;
    this.cacheMax = Math.max(1, opts.cacheMax ?? AUTH_CACHE_MAX);
  }

  /** Entries per cache (tests and diagnostics). */
  cacheSizes(): { install: number; web: number; pulse: number; jwtStatus: number } {
    return { install: this.installCache.size, web: this.webCache.size, pulse: this.pulseCache.size, jwtStatus: this.jwtStatusCache.size };
  }

  /** Is this install still usable (not revoked; agent and owner active)? For stateless pulse tokens. */
  async installActive(installId: string): Promise<boolean> {
    const r = await this.db.asService((tx) =>
      tx.query<{ revoked: boolean; agent_status: string; user_status: string }>('select * from api.install_state($1)', [installId]),
    );
    const row = r.rows[0];
    return Boolean(row && !row.revoked && row.agent_status === 'active' && row.user_status === 'active');
  }

  /** A 60 s token for GET /api/v1/stream?token= (web callers only). */
  mintStreamToken(caller: Caller): { token: string; expiresAt: string } {
    const exp = Math.floor(this.now().getTime() / 1000) + STREAM_TOKEN_TTL_S;
    const body = Buffer.from(JSON.stringify({ u: caller.userId, v: caller.via, t: caller.authTime ?? null, e: exp })).toString('base64url');
    return { token: `${STREAM_TOKEN_PREFIX}${body}.${hmacHex(this.streamKey, body)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** Verify a stream token. Only the stream route accepts these (never as a bearer). */
  verifyStreamToken(token: string): Caller | null {
    if (!token.startsWith(STREAM_TOKEN_PREFIX) || token.length > 1024) return null;
    const rest = token.slice(STREAM_TOKEN_PREFIX.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = rest.slice(0, dot);
    if (!safeEqual(hmacHex(this.streamKey, body), rest.slice(dot + 1))) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u: string; v: string; t: number | null; e: number };
      if (typeof p.e !== 'number' || p.e * 1000 < this.now().getTime() || typeof p.u !== 'string' || !p.u) return null;
      return webCaller(p.u, p.v === 'dev' ? 'dev' : 'web', typeof p.t === 'number' ? p.t : null);
    } catch {
      return null;
    }
  }

  /** Resolve an install token with its state (for the brief, which reports revoked/unknown). Cached 60 s. */
  async resolveInstall(token: string): Promise<InstallResolution> {
    if (!/^pcl_agt_[A-Za-z0-9]{32}$/.test(token)) return { state: 'unknown_install' };
    const hash = sha256Hex(token);
    const t = this.now().getTime();
    const hit = this.installCache.get(hash);
    if (hit && t - hit.at < CACHE_MS) return hit.value;
    const rows = await this.db.asAnon((tx) =>
      tx.query<InstallRow>('select * from api.resolve_install_token($1)', [hash]),
    );
    const r = rows.rows[0];
    let value: InstallResolution;
    if (!r) value = { state: 'unknown_install' };
    else if (r.revoked || r.agent_status !== 'active' || r.user_status !== 'active') value = { state: 'revoked' };
    else
      value = {
        state: 'ok',
        caller: installCaller(r.owner_user_id, r.agent_id, r.install_id),
        handle: r.agent_handle,
        harness: r.harness,
      };
    setBounded(this.installCache, hash, { at: t, value }, this.cacheMax);
    return value;
  }

  /** Drop cached install resolutions (after a revoke). */
  invalidate(): void {
    this.installCache.clear();
    this.webCache.clear();
    this.pulseCache.clear();
    this.jwtStatusCache.clear();
  }

  mintPulseToken(caller: Caller): { token: string; expiresAt: string } {
    const exp = Math.floor(this.now().getTime() / 1000) + PULSE_TOKEN_TTL_S;
    const body = Buffer.from(JSON.stringify({ u: caller.userId, a: caller.agentId, i: caller.installId, e: exp })).toString(
      'base64url',
    );
    const sig = hmacHex(this.pulseKey, body);
    return { token: `${PULSE_TOKEN_PREFIX}${body}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  private verifyPulse(token: string): Caller | null {
    const rest = token.slice(PULSE_TOKEN_PREFIX.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = rest.slice(0, dot);
    if (!safeEqual(hmacHex(this.pulseKey, body), rest.slice(dot + 1))) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u: string; a: string; i: string; e: number };
      if (typeof p.e !== 'number' || p.e * 1000 < this.now().getTime()) return null;
      if (typeof p.u !== 'string' || typeof p.a !== 'string' || typeof p.i !== 'string') return null;
      if (!UUID_RE.test(p.u) || !UUID_RE.test(p.a) || !UUID_RE.test(p.i)) return null;
      return installCaller(p.u, p.a, p.i);
    } catch {
      return null;
    }
  }

  /** A pulse token is only as good as its install: live, and of that agent and owner. Cached 60 s. */
  private async pulseInstallOk(caller: Caller): Promise<boolean> {
    const key = `${caller.installId}:${caller.agentId}:${caller.userId}`;
    const t = this.now().getTime();
    const hit = this.pulseCache.get(key);
    if (hit && t - hit.at < CACHE_MS) return hit.value;
    const r = await this.db.asService((tx) =>
      tx.query<{ agent_id: string; owner_user_id: string; revoked: boolean; agent_status: string; user_status: string }>(
        'select * from api.pulse_install($1)',
        [caller.installId],
      ),
    );
    const row = r.rows[0];
    const ok = Boolean(
      row &&
        row.agent_id === caller.agentId &&
        row.owner_user_id === caller.userId &&
        !row.revoked &&
        row.agent_status === 'active' &&
        row.user_status === 'active',
    );
    setBounded(this.pulseCache, key, { at: t, value: ok }, this.cacheMax);
    return ok;
  }

  private async verifyWeb(token: string): Promise<Caller | null> {
    if (!/^pcl_web_[A-Za-z0-9]{32}$/.test(token)) return null;
    const hash = sha256Hex(token);
    const t = this.now().getTime();
    const hit = this.webCache.get(hash);
    if (hit && t - hit.at < CACHE_MS) return hit.value;
    const rows = await this.db.asAnon((tx) =>
      tx.query<{ user_id: string; user_status: string; created_at: Date | string; demo_account?: string | null }>(
        'select * from api.resolve_web_session($1)',
        [hash],
      ),
    );
    const r = rows.rows[0];
    // A /dev/demo session lives only as long as the server still offers that demo account.
    const demo = r?.demo_account ?? null;
    const demoOk = demo === null || (this.config.demoAccount ?? '').toLowerCase() === demo.toLowerCase();
    const value =
      r && r.user_status === 'active' && demoOk ? webCaller(r.user_id, 'dev', Math.floor(new Date(r.created_at).getTime() / 1000)) : null;
    setBounded(this.webCache, hash, { at: t, value }, this.cacheMax);
    return value;
  }

  private async verifyJwt(token: string): Promise<Caller | null> {
    if (!this.jwks && !this.hsKey) return null;
    try {
      const alg = decodeProtectedHeader(token).alg;
      const opts = {
        audience: 'authenticated',
        ...(this.config.supabase.url ? { issuer: `${this.config.supabase.url}/auth/v1` } : {}),
        clockTolerance: 30,
        currentDate: this.now(),
      };
      let payload: JWTPayload;
      if (alg === 'HS256') {
        if (!this.hsKey) return null;
        ({ payload } = await jwtVerify(token, this.hsKey, { ...opts, algorithms: ['HS256'] }));
      } else {
        if (!this.jwks) return null;
        ({ payload } = await jwtVerify(token, this.jwks, { ...opts, algorithms: ['ES256', 'RS256', 'EdDSA'] }));
      }
      const sub = payload.sub;
      if (typeof sub !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub)) return null;
      if (payload.role !== undefined && payload.role !== 'authenticated') return null;
      if ((payload as { is_anonymous?: unknown }).is_anonymous === true) return null;
      await this.provision(sub, payload);
      if (!(await this.userActive(sub))) return null;
      return webCaller(sub, 'web', supabaseAuthTime(payload));
    } catch {
      return null;
    }
  }

  /** First web call of a Supabase user: make sure public.users exists (handle from GitHub user_name). */
  private async provision(sub: string, payload: JWTPayload): Promise<void> {
    if (this.provisioned.has(sub)) return;
    const meta = (payload as { user_metadata?: unknown }).user_metadata;
    const app = (payload as { app_metadata?: unknown }).app_metadata;
    const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    await this.db.asService((tx) =>
      tx.query('select y_private.provision_user($1, $2::jsonb, $3::jsonb)', [sub, JSON.stringify(obj(meta)), JSON.stringify(obj(app))]),
    );
    if (this.provisioned.size > 10_000) this.provisioned.clear();
    this.provisioned.add(sub);
  }

  /** public.users.status = 'active' (a missing row is not active). Cached 60 s, like web sessions. */
  private async userActive(sub: string): Promise<boolean> {
    const t = this.now().getTime();
    const hit = this.jwtStatusCache.get(sub);
    if (hit && t - hit.at < CACHE_MS) return hit.value;
    const r = await this.db.asService((tx) => tx.query<{ status: string }>('select status from public.users where id = $1', [sub]));
    const ok = r.rows[0]?.status === 'active';
    setBounded(this.jwtStatusCache, sub, { at: t, value: ok }, this.cacheMax);
    return ok;
  }

  async verifyBearer(authorizationHeader: string | undefined): Promise<Caller | null> {
    const m = /^Bearer\s+(\S{1,4096})$/i.exec(authorizationHeader?.trim() ?? '');
    const token = m?.[1];
    if (!token) return null;
    if (token.startsWith(INSTALL_TOKEN_PREFIX)) {
      const r = await this.resolveInstall(token);
      return r.state === 'ok' ? r.caller : null;
    }
    if (token.startsWith(PULSE_TOKEN_PREFIX)) {
      const caller = this.verifyPulse(token);
      return caller && (await this.pulseInstallOk(caller)) ? caller : null;
    }
    if (token.startsWith(STREAM_TOKEN_PREFIX)) return null; // query-string only, stream route only
    if (token.startsWith(WEB_TOKEN_PREFIX)) return this.config.devAuth ? this.verifyWeb(token) : null;
    return this.verifyJwt(token);
  }

  /**
   * HMAC over `internalSigningString` (packages/schema internal.ts): domain line,
   * unix time, method, path, sha256(body), sha256(Authorization) or '-'.
   * Timing-safe compare, ±300 s window.
   */
  verifyInternal(req: { method: string; path: string; body: string; header: (name: string) => string | undefined }): boolean {
    const raw = req.header('x-y-internal');
    if (!raw) return false;
    const parsed = parseInternalSignatureHeader(raw);
    if (!parsed) return false;
    const nowS = Math.floor(this.now().getTime() / 1000);
    if (Math.abs(nowS - parsed.timestamp) > INTERNAL_SIGNATURE_MAX_SKEW_S) return false;
    const auth = req.header('authorization');
    const expected = hmacHex(
      this.config.internalSecret,
      internalSigningString({
        timestamp: parsed.timestamp,
        method: req.method,
        path: req.path,
        bodySha256: sha256Hex(req.body),
        authSha256: auth ? sha256Hex(auth) : '-',
      }),
    );
    return safeEqual(expected, parsed.hmacHex);
  }
}
