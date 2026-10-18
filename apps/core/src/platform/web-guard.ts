/**
 * Browser-facing hardening, applied in createApp before every module's routes:
 *
 * - CORS for PACELINE_WEB_ORIGIN (credentials false: the web app sends bearer tokens).
 * - Origin check on mutating web routes: a browser request whose Origin is not an
 *   allowed web origin (or core's own) is rejected. Requests without Origin
 *   (CLI, hooks, server-to-server) pass; they cannot ride a browser's cookies.
 * - Demo gate: when PACELINE_DEMO_SECRET is set, /api/v1/dev/* needs X-Demo-Secret.
 * - Step-up (I5): review decisions and owner instructions need a web login
 *   younger than 12 h (STEP_UP_REQUIRED otherwise).
 */
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { CoreDeps } from '../contracts.js';
import { STEP_UP_MAX_AGE_S } from './auth.js';
import { bearerFrom } from './http.js';
import { fail, safeEqual, sha256Hex } from './util.js';

/** Agent/plugin/internal routes: never browser-called, no Origin rules. */
const NON_WEB = [/^\/api\/v1\/ingest$/, /^\/api\/v1\/hook\//, /^\/api\/v1\/pulse(\/|$)/, /^\/api\/v1\/agent\//, /^\/internal\//];
const STEP_UP_ROUTES = [/^\/api\/v1\/review\/[^/]+\/decision$/, /^\/api\/v1\/threads\/[^/]+\/instruct$/];
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const CORS_ALLOW_HEADERS = [
  'authorization',
  'content-type',
  'idempotency-key',
  'last-event-id',
  'x-demo-secret',
];

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function allowedOrigins(deps: CoreDeps): Set<string> {
  const set = new Set(deps.config.webOrigins ?? []);
  const own = originOf(deps.config.publicUrl);
  if (own) set.add(own);
  return set;
}

export function registerWebGuards(app: Hono, deps: CoreDeps): void {
  const origins = allowedOrigins(deps);
  const webOrigins = new Set(deps.config.webOrigins ?? []);

  if (webOrigins.size > 0) {
    app.use(
      '/api/*',
      cors({
        origin: (o) => (webOrigins.has(o) ? o : null),
        credentials: false,
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: CORS_ALLOW_HEADERS,
        exposeHeaders: ['retry-after'],
        maxAge: 600,
      }),
    );
  }

  const originGuard: MiddlewareHandler = async (c, next) => {
    if (!MUTATING.has(c.req.method) || NON_WEB.some((r) => r.test(c.req.path))) return next();
    const origin = c.req.header('origin');
    if (origin !== undefined && !origins.has(origin)) {
      return fail(c, 'SCOPE_FORBIDDEN', 'this origin may not call the web API');
    }
    return next();
  };
  app.use('/api/*', originGuard);

  const demo = deps.config.demoSecret ?? null;
  if (demo) {
    const want = sha256Hex(demo);
    app.use('/api/v1/dev/*', async (c, next) => {
      const got = c.req.header('x-demo-secret');
      if (!got || !safeEqual(sha256Hex(got), want)) return fail(c, 'UNAUTHORIZED', 'demo login needs X-Demo-Secret');
      return next();
    });
  }

  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'POST' || !STEP_UP_ROUTES.some((r) => r.test(c.req.path))) return next();
    const res = await requireRecentLogin(c, deps);
    return res ?? next();
  });
}

/** STEP_UP_REQUIRED when the caller is a web session older than {@link STEP_UP_MAX_AGE_S}. Non-web callers fall through to the route. */
export async function requireRecentLogin(c: Context, deps: CoreDeps): Promise<Response | null> {
  const caller = await deps.auth.verifyBearer(bearerFrom(c));
  if (!caller || (caller.via !== 'web' && caller.via !== 'dev')) return null;
  const at = caller.authTime ?? null;
  const nowS = Math.floor(deps.now().getTime() / 1000);
  if (at === null || nowS - at > STEP_UP_MAX_AGE_S) {
    return fail(c, 'STEP_UP_REQUIRED', 'sign in again to approve (sessions older than 12 h cannot decide)', {
      next: { humanAction: 'step_up', url: `${(deps.config.webOrigins ?? [])[0] ?? deps.config.publicUrl}/login` },
    });
  }
  return null;
}
