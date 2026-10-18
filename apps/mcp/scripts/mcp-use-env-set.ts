/**
 * `mcp-use servers env set <server> KEY=VALUE` without VALUE in any process's argv.
 *
 * The mcp-use CLI only takes the value as a positional argument, so a shell call
 * puts it in the process table (ps, /proc/<pid>/cmdline, process accounting).
 * This wrapper reads VALUE from its own environment (`process.env[KEY]`) and
 * runs the pinned workspace mcp-use CLI in-process with a rewritten
 * `process.argv`: that array is JS memory, never the OS-visible command line.
 *
 *   tsx scripts/mcp-use-env-set.ts <server-id> <KEY> [--secret]
 *
 * `Y_MCP_USE_BIN` overrides the CLI entry (tests point it at a fake).
 */
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The argv tail handed to the mcp-use CLI. */
export function envSetArgs(server: string, key: string, value: string, secret: boolean): string[] {
  return ['servers', 'env', 'set', server, `${key}=${value}`, ...(secret ? ['--secret'] : []), '--json'];
}

/** The pinned mcp-use CLI entry from apps/mcp/node_modules (never a registry download). */
export function mcpUseBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.Y_MCP_USE_BIN?.trim();
  return override ? path.resolve(override) : realpathSync(path.join(MCP_ROOT, 'node_modules', 'mcp-use', 'dist', 'bin.js'));
}

async function main(argv: string[]): Promise<void> {
  const flags = argv.filter((a) => a.startsWith('--'));
  const pos = argv.filter((a) => !a.startsWith('--'));
  const unknown = flags.filter((f) => f !== '--secret');
  if (pos.length !== 2 || unknown.length > 0) {
    throw new Error('usage: mcp-use-env-set.ts <server-id> <KEY> [--secret]  (the value is read from $KEY)');
  }
  const [server, key] = pos as [string, string];
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`not an env var name: ${key}`);
  const value = process.env[key];
  if (value === undefined || value === '') throw new Error(`${key} is not set in the environment`);
  const bin = mcpUseBin();
  process.argv = [process.execPath, bin, ...envSetArgs(server, key, value, flags.includes('--secret'))];
  await import(pathToFileURL(bin).href);
}

/**
 * True when this file is the process entry. Compares realpaths: argv[1] is the
 * path as invoked (possibly through a symlinked checkout or /tmp -> /private/tmp)
 * while import.meta.url is already resolved, so a plain path compare would skip
 * main() and exit 0 without setting anything.
 */
export function isEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(path.resolve(argv1)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`mcp-use-env-set: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
