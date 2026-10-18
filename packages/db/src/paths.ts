/**
 * Well-known locations, resolved from this package's own source location so
 * they work no matter which directory a script runs from.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

/** Absolute paths used by the migration runner, the test helpers and the CLI. */
export const paths = {
  /** packages/db */
  packageDir: resolve(packageDir),
  /** The monorepo root (contains pnpm-workspace.yaml). */
  repoRoot: resolve(packageDir, '..', '..'),
  /** supabase/migrations: numbered SQL migrations, applied in lexical order. */
  migrationsDir: resolve(packageDir, '..', '..', 'supabase', 'migrations'),
  /** supabase/tests: pgTAP test files run by the SQL test runner. */
  sqlTestsDir: resolve(packageDir, '..', '..', 'supabase', 'tests'),
  /** The built-in Supabase shims applied on local databases only. */
  localShims: fileURLToPath(new URL('./local-shims.sql', import.meta.url)),
} as const;

/**
 * Finds the nearest ancestor of `from` (inclusive) that contains
 * `pnpm-workspace.yaml`, or undefined.
 */
export function findWorkspaceRoot(from: string = process.cwd()): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const MEMORY_VALUES = new Set(['memory', ':memory:', 'memory://']);

/**
 * Resolves `Y_DATA_DIR` to an absolute directory, or `'memory'`.
 *
 * - Unset or empty: `.pglite`.
 * - `memory`, `:memory:` or `memory://`: an in-memory database.
 * - Relative paths resolve against the workspace root (found from `cwd`), so
 *   `pnpm --filter` scripts in different packages share one local database;
 *   outside a workspace they resolve against `cwd`.
 */
export function resolveDataDir(value: string | undefined, cwd: string = process.cwd()): string | 'memory' {
  const raw = value?.trim() || '.pglite';
  if (MEMORY_VALUES.has(raw.toLowerCase())) return 'memory';
  if (isAbsolute(raw)) return resolve(raw);
  return resolve(findWorkspaceRoot(cwd) ?? cwd, raw);
}
