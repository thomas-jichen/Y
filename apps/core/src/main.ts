/** Server-mode entrypoint: `pnpm --filter @y/core dev`. */
import { serve } from '@hono/node-server';
import { createDb, migrate } from '@y/db';
import { createApp, allJobHandlers } from './app.js';
import { createDeps, loadConfig } from './platform/index.js';
import { listenHosts } from './platform/config.js';

const config = loadConfig();
const db = await createDb();
await migrate(db);
const deps = await createDeps(config, db, allJobHandlers());
const app = createApp(deps);
const hosts = listenHosts(config);
if (!hosts) serve({ fetch: app.fetch, port: config.port });
else {
  hosts.forEach((hostname, i) => {
    const server = serve({ fetch: app.fetch, port: config.port, hostname });
    // The first address is required (errors crash as before); the IPv6 loopback is best effort.
    if (i > 0) server.on('error', (e) => deps.log('warn', `not listening on ${hostname}`, { e: String(e) }));
  });
}
deps.log('info', `y core listening on ${config.publicUrl} (mode=${config.mode}${hosts ? `, bound to ${hosts.join(' and ')}; set HOST to change` : ''})`);
if (config.mode === 'server') {
  const loop = async () => { try { await deps.jobs.drain(20); } catch (e) { deps.log('error', 'job loop', { e: String(e) }); } setTimeout(loop, 500); };
  void loop();
}
