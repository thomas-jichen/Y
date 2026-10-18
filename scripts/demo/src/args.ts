/** Argument parsing for the demo CLI (`--api URL --mcp URL [--demo-secret S] [--pace normal|fast]`). */
import type { Pace } from './demo.js';

export interface CliArgs {
  api: string;
  mcp: string;
  demoSecret?: string;
  pace: Pace;
  web?: string;
  expectSeeds: boolean;
  showTokens: boolean;
}

export const USAGE =
  'usage: pnpm --filter @paceline/demo start -- --api <coreUrl> --mcp <mcpUrl> [--demo-secret S] [--pace normal|fast] [--web <webUrl>] [--expect-seeds] [--show-tokens]';

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const a = argv.filter((x) => x !== '--');
  const val = (name: string): string | undefined => {
    const i = a.findIndex((x) => x === `--${name}` || x.startsWith(`--${name}=`));
    if (i < 0) return undefined;
    const cur = a[i]!;
    if (cur.includes('=')) return cur.slice(cur.indexOf('=') + 1);
    const next = a[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`--${name} needs a value\n${USAGE}`);
    return next;
  };
  const api = val('api') ?? env.PACELINE_API_URL;
  const mcp = val('mcp') ?? env.PACELINE_MCP_URL;
  if (!api || !mcp) throw new Error(USAGE);
  const pace = val('pace') ?? 'normal';
  if (pace !== 'normal' && pace !== 'fast') throw new Error(`--pace must be normal or fast\n${USAGE}`);
  const demoSecret = val('demo-secret') ?? env.PACELINE_DEMO_SECRET;
  const web = val('web');
  return {
    api,
    mcp,
    pace,
    ...(demoSecret ? { demoSecret } : {}),
    ...(web ? { web } : {}),
    expectSeeds: a.includes('--expect-seeds'),
    showTokens: a.includes('--show-tokens'),
  };
}
