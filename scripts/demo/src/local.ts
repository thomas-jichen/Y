/**
 * `pnpm demo:local`: core (in-memory PGlite, fixed dev internal secret) on :8787 and the
 * MCP server on :3000, seeds loaded, then the narrated demo. The servers stay up until
 * Ctrl-C so you can keep clicking around the web app.
 *
 *   DEMO_PACE=fast pnpm demo:local      # no pauses
 *   DEMO_CORE_PORT / DEMO_MCP_PORT      # other ports
 *   DEMO_EXIT=1                         # exit after the demo instead of staying up
 */
import { runDemo } from './demo.js';
import { loadSeeds, waitForEmbeddings } from './seeds.js';
import { startLocalStack } from './servers.js';

/** Dev-only shared secret between core and mcp (local demo; never used in production). */
const LOCAL_INTERNAL_SECRET = 'y-local-demo-internal-secret-not-for-production';
const WEB_URL = 'http://localhost:5173';

const pace = process.env.DEMO_PACE === 'fast' || process.argv.includes('--fast') ? 'fast' : 'normal';
const stack = await startLocalStack({
  host: 'localhost',
  corePort: Number(process.env.DEMO_CORE_PORT) || 8787,
  mcpPort: Number(process.env.DEMO_MCP_PORT) || 3000,
  internalSecret: LOCAL_INTERNAL_SECRET,
  verbose: true,
});
console.log(`core  ${stack.coreUrl}   (Y_DATA_DIR=memory)`);
console.log(`mcp   ${stack.mcpUrl}`);

const seeds = await loadSeeds(stack.db, stack.deps);
await waitForEmbeddings(stack.db);
console.log(`seeds ${seeds.inserted + seeds.updated} public gotchas loaded by @yhq (${seeds.skipped.length} skipped by the L0 screen, ${seeds.trimmed.length} trimmed to fit)`);
console.log('');
console.log(`web   open ${WEB_URL} (run apps/web with VITE_API_URL unset so it proxies to ${stack.coreUrl})`);
console.log('');

const res = await runDemo({
  api: stack.coreUrl,
  mcp: stack.mcpUrl,
  pace,
  webUrl: WEB_URL,
  expectSeeds: true,
  isolateStranger: stack.isolateStranger,
});

if (process.env.DEMO_EXIT === '1') {
  await stack.stop();
  process.exit(res.ok ? 0 : 1);
}
console.log('');
console.log(`Servers are still running: core ${stack.coreUrl}, mcp ${stack.mcpUrl}, web ${WEB_URL}. Ctrl-C to stop.`);
const shutdown = async () => {
  await stack.stop().catch(() => undefined);
  process.exit(res.ok ? 0 : 1);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
