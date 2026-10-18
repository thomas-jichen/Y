/**
 * POST /api/v1/stream-token → {token, expiresAt}: a 60 s token for
 * `GET /api/v1/stream?token=` (EventSource can't send an Authorization
 * header). Web callers only; the token is accepted by the stream route alone.
 */
import type { Hono } from 'hono';
import type { CoreDeps } from '../../contracts.js';
import { PlatformAuth } from '../auth.js';
import { authenticate } from '../http.js';
import { fail } from '../util.js';

export function registerStreamTokenRoute(app: Hono, deps: CoreDeps): void {
  app.post('/api/v1/stream-token', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    if (!(deps.auth instanceof PlatformAuth)) return fail(c, 'NOT_FOUND', 'stream tokens are not available');
    return c.json(deps.auth.mintStreamToken(caller));
  });
}
