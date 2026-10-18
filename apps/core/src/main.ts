/** Server-mode entrypoint: `pnpm --filter @paceline/core dev`. */
import { serve } from '@hono/node-server';
import { createDb, migrate } from '@paceline/db';
import { createApp, allJobHandlers } from './app.js';
import { createDeps, loadConfig } from './platform/index.js';

const config = loadConfig();
const db = await createDb();
await migrate(db);
const deps = await createDeps(config, db, allJobHandlers());
const app = createApp(deps);
serve({ fetch: app.fetch, port: config.port });
deps.log('info', `paceline core listening on ${config.publicUrl} (mode=${config.mode})`);
if (config.mode === 'server') {
  const loop = async () => { try { await deps.jobs.drain(20); } catch (e) { deps.log('error', 'job loop', { e: String(e) }); } setTimeout(loop, 500); };
  void loop();
}
