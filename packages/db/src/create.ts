/**
 * Picks an adapter from the environment.
 */
import { resolveDataDir } from './paths.js';
import { createPgDb } from './pg.js';
import { createPgliteDb } from './pglite.js';
import type { Db, DbErrorReporter } from './types.js';

/** Environment variables read by {@link createDb}. */
export interface DbEnv {
  /** Postgres/Supabase connection string. When set, the `pg` adapter is used. */
  DATABASE_URL?: string | undefined;
  /** Optional separate connection string for LISTEN (direct or session-mode pooler). */
  DATABASE_LISTEN_URL?: string | undefined;
  /** `1`/`true` marks a plain local Postgres as local (shims + `_local_` migrations). */
  PACELINE_DB_LOCAL?: string | undefined;
  /** PGlite data directory (default `.pglite` at the workspace root), or `memory`. */
  PACELINE_DATA_DIR?: string | undefined;
  [key: string]: string | undefined;
}

/** Options for {@link createDb}. */
export interface CreateDbOptions {
  /** Base for resolving a relative `PACELINE_DATA_DIR`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Load pgTAP into PGlite. */
  pgtap?: boolean;
  /** Receives errors with no caller to throw to. */
  onError?: DbErrorReporter;
}

/** Parses a boolean-ish environment flag (`1`, `true`, `yes`, `on`). */
export function envFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

/**
 * Creates the database for this process: `pg` when `DATABASE_URL` is set,
 * otherwise PGlite at `PACELINE_DATA_DIR` (default `.pglite`; `memory` for an
 * in-memory database). Does not run migrations; call `migrate(db)`.
 */
export async function createDb(env: DbEnv = process.env, options: CreateDbOptions = {}): Promise<Db> {
  const url = env.DATABASE_URL?.trim();
  if (url) {
    const listenUrl = env.DATABASE_LISTEN_URL?.trim();
    return createPgDb({
      connectionString: url,
      ...(listenUrl ? { listenConnectionString: listenUrl } : {}),
      local: envFlag(env.PACELINE_DB_LOCAL),
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }
  return createPgliteDb({
    dataDir: resolveDataDir(env.PACELINE_DATA_DIR, options.cwd),
    ...(options.pgtap ? { pgtap: true } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
}
