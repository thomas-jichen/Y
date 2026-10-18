/** `pnpm --filter @paceline/demo start -- --api <coreUrl> --mcp <mcpUrl> [--demo-secret S] [--pace normal|fast]` */
import { parseArgs } from './args.js';
import { runDemo } from './demo.js';

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(64);
}
const res = await runDemo({
  api: args.api,
  mcp: args.mcp,
  demoSecret: args.demoSecret,
  pace: args.pace,
  expectSeeds: args.expectSeeds,
  showTokens: args.showTokens,
  ...(args.web ? { webUrl: args.web } : {}),
});
process.exit(res.ok ? 0 : 1);
