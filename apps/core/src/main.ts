/** Server-mode entrypoint: `pnpm --filter @y/core dev`. */
import { serve } from '@hono/node-server';
import { createDb, migrate } from '@y/db';
import { createApp, allJobHandlers } from './app.js';
import { createDeps, loadConfig } from './platform/index.js';

const config = loadConfig();
const db = await createDb();
await migrate(db);
const deps = await createDeps(config, db, allJobHandlers());
const app = createApp(deps);
serve({ fetch: app.fetch, port: config.port });
deps.log('info', `y core listening on ${config.publicUrl} (mode=${config.mode})`);
if (config.mode === 'server') {
  const loop = async () => { try { await deps.jobs.drain(20); } catch (e) { deps.log('error', 'job loop', { e: String(e) }); } setTimeout(loop, 500); };
  void loop();
}
