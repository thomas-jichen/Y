/**
 * POST /api/v1/stream-token → {token, expiresAt}: a 60 s token for
 * `GET /api/v1/stream?token=` (EventSource can't send an Authorization
 * header). Web callers only; the token is accepted by the stream route alone.
 * Rate limited per human (STREAM_TOKEN_BUCKET, 60 / min, burst 120); the check fails open on a
 * database error, like the stream connect check.
 */
import type { Hono } from 'hono';
import type { CoreDeps } from '../../contracts.js';
import { PlatformAuth } from '../auth.js';
import { authenticate } from '../http.js';
import { STREAM_TOKEN_BUCKET, takeToken, type TakeResult } from '../rate-limit.js';
import { fail } from '../util.js';

export function registerStreamTokenRoute(app: Hono, deps: CoreDeps): void {
  app.post('/api/v1/stream-token', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    if (!(deps.auth instanceof PlatformAuth)) return fail(c, 'NOT_FOUND', 'stream tokens are not available');
    let rl: TakeResult = { allowed: true };
    try {
      rl = await deps.db.asUser(caller.claims, (tx) => takeToken(tx, 'web:stream_token', [caller.userId], STREAM_TOKEN_BUCKET));
    } catch (e) {
      deps.log('warn', 'stream token rate check failed', { err: String(e) }); // fail open: a DB blip must not refuse streams
    }
    if (!rl.allowed) {
      return fail(c, 'RATE_LIMITED', 'too many stream tokens; retry shortly', { retryable: true, retryAfterS: rl.retryAfterS });
    }
    return c.json(deps.auth.mintStreamToken(caller));
  });
}
