/**
 * AuthService: install tokens (`pcl_agt_…`), dev web sessions (`pcl_web_…`),
 * pulse tokens (`pcl_pls_…`, short-lived, HMAC-signed), Supabase JWTs (JWKS),
 * and the apps/mcp → core internal HMAC (`X-Paceline-Internal`).
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Db } from '@paceline/db';
import {
  INTERNAL_SIGNATURE_MAX_SKEW_S,
  internalSigningString,
  parseInternalSignatureHeader,
} from '@paceline/schema';
import type { AuthService, Caller, CoreConfig } from '../contracts.js';
import {
  INSTALL_TOKEN_PREFIX,
  PULSE_TOKEN_PREFIX,
  WEB_TOKEN_PREFIX,
  hmacHex,
  safeEqual,
  sha256Hex,
} from './util.js';

const CACHE_MS = 60_000;
export const PULSE_TOKEN_TTL_S = 3600;

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

export function webCaller(userId: string, via: 'web' | 'dev'): Caller {
  // claims.via is 'web' for both: is_human() keys on it (dev sessions are human web sessions).
  return { userId, agentId: null, installId: null, via, claims: { sub: userId, via: 'web' } };
}

export class PlatformAuth implements AuthService {
  private readonly installCache = new Map<string, { at: number; value: InstallResolution }>();
  private readonly webCache = new Map<string, { at: number; value: Caller | null }>();
  private readonly jwks: JWTVerifyGetKey | null;
  private readonly pulseKey: string;

  constructor(
    private readonly config: CoreConfig,
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.jwks = config.supabase.jwksUrl ? createRemoteJWKSet(new URL(config.supabase.jwksUrl)) : null;
    this.pulseKey = `paceline-pulse-v1\n${config.internalSecret}`;
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
    this.installCache.set(hash, { at: t, value });
    return value;
  }

  /** Drop cached install resolutions (after a revoke). */
  invalidate(): void {
    this.installCache.clear();
    this.webCache.clear();
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
      if (!p.u || !p.a || !p.i) return null;
      return installCaller(p.u, p.a, p.i);
    } catch {
      return null;
    }
  }

  private async verifyWeb(token: string): Promise<Caller | null> {
    if (!/^pcl_web_[A-Za-z0-9]{32}$/.test(token)) return null;
    const hash = sha256Hex(token);
    const t = this.now().getTime();
    const hit = this.webCache.get(hash);
    if (hit && t - hit.at < CACHE_MS) return hit.value;
    const rows = await this.db.asAnon((tx) =>
      tx.query<{ user_id: string; user_status: string }>('select * from api.resolve_web_session($1)', [hash]),
    );
    const r = rows.rows[0];
    const value = r && r.user_status === 'active' ? webCaller(r.user_id, 'dev') : null;
    this.webCache.set(hash, { at: t, value });
    return value;
  }

  private async verifyJwt(token: string): Promise<Caller | null> {
    if (!this.jwks) return null;
    try {
      const { payload } = await jwtVerify(token, this.jwks, { audience: 'authenticated' });
      if (typeof payload.sub !== 'string' || !payload.sub) return null;
      return webCaller(payload.sub, 'web');
    } catch {
      return null;
    }
  }

  async verifyBearer(authorizationHeader: string | undefined): Promise<Caller | null> {
    const m = /^Bearer\s+(\S{1,4096})$/i.exec(authorizationHeader?.trim() ?? '');
    const token = m?.[1];
    if (!token) return null;
    if (token.startsWith(INSTALL_TOKEN_PREFIX)) {
      const r = await this.resolveInstall(token);
      return r.state === 'ok' ? r.caller : null;
    }
    if (token.startsWith(PULSE_TOKEN_PREFIX)) return this.verifyPulse(token);
    if (token.startsWith(WEB_TOKEN_PREFIX)) return this.config.devAuth ? this.verifyWeb(token) : null;
    return this.verifyJwt(token);
  }

  /**
   * HMAC over `internalSigningString` (packages/schema internal.ts): domain line,
   * unix time, method, path, sha256(body), sha256(Authorization) or '-'.
   * Timing-safe compare, ±300 s window.
   */
  verifyInternal(req: { method: string; path: string; body: string; header: (name: string) => string | undefined }): boolean {
    const raw = req.header('x-paceline-internal');
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
