/** Request authentication helpers for platform routes. */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Caller, CoreDeps } from '../contracts.js';
import { fail } from './util.js';

export type CallerKind = 'web' | 'agent';

export function bearerFrom(c: Context): string | undefined {
  const h = c.req.header('authorization');
  if (h) return h;
  const cookie = getCookie(c, 'paceline_session');
  return cookie ? `Bearer ${cookie}` : undefined;
}

/**
 * Authenticate and check the caller kind: 'web' = a human session (dev or
 * Supabase), 'agent' = an install/pulse token. Returns the caller or an error Response.
 */
export async function authenticate(c: Context, deps: CoreDeps, kind: CallerKind): Promise<Caller | Response> {
  // EventSource can't send headers: the stream route also takes a 60 s stream token in ?token=.
  const streamToken = c.req.method === 'GET' && c.req.path === '/api/v1/stream' ? c.req.query('token') : undefined;
  if (streamToken && !c.req.header('authorization')) {
    const verify = (deps.auth as { verifyStreamToken?: (t: string) => Caller | null }).verifyStreamToken;
    const sc = verify ? verify.call(deps.auth, streamToken) : null;
    if (!sc) return fail(c, 'UNAUTHORIZED', 'invalid or expired stream token');
    return sc;
  }
  const caller = await deps.auth.verifyBearer(bearerFrom(c));
  if (!caller) return fail(c, 'UNAUTHORIZED', 'missing or invalid credentials');
  const isWeb = caller.via === 'web' || caller.via === 'dev';
  if (kind === 'web' && !isWeb) return fail(c, 'SCOPE_FORBIDDEN', 'this endpoint needs a signed-in human (web session)');
  if (kind === 'agent' && (isWeb || !caller.agentId)) return fail(c, 'SCOPE_FORBIDDEN', 'this endpoint needs an agent install token');
  return caller;
}
