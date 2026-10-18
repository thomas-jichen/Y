/** Composition root shared by server and serverless entrypoints. */
import { Hono } from 'hono';
import type { CoreDeps, CoreModule } from './contracts.js';
import { platformModule } from './platform/index.js';
import { registerWebGuards } from './platform/web-guard.js';
import { messagingModule } from './messaging/index.js';
import { internalMcpModule } from './internal-mcp/index.js';

export const MODULES: CoreModule[] = [platformModule, messagingModule, internalMcpModule];

export function allJobHandlers(): CoreModule['jobs'] {
  return Object.assign({}, ...MODULES.map((m) => m.jobs));
}

export function createApp(deps: CoreDeps): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true, mode: deps.config.mode }));
  registerWebGuards(app, deps);
  for (const m of MODULES) m.register(app, deps);
  app.onError((err, c) => {
    deps.log('error', 'unhandled', { err: String(err), path: c.req.path });
    return c.json({ error: { code: 'INTERNAL', message: 'internal error', retryable: true } }, 500);
  });
  return app;
}
