/**
 * Picks an adapter from the environment.
 */
import { resolveDataDir } from './paths.js';
import { createPgDb } from './pg.js';
import { createPgliteDb } from './pglite.js';
import type { Db, DbErrorReporter, DbFlavor } from './types.js';

/** Environment variables read by {@link createDb}. */
export interface DbEnv {
  /** Postgres/Supabase connection string. When set, the `pg` adapter is used (unless the flavor is `pglite`). */
  DATABASE_URL?: string | undefined;
  /** Optional separate connection string for LISTEN (direct or session-mode pooler). */
  DATABASE_LISTEN_URL?: string | undefined;
  /**
   * `pglite` | `postgres` | `supabase` (see {@link DbFlavor}). Default:
   * `pglite` without `DATABASE_URL`; with it, `postgres` when
   * `PACELINE_DB_LOCAL` is set, else `supabase`.
   */
  PACELINE_DB_FLAVOR?: string | undefined;
  /** `1`/`true` marks a plain local Postgres as local (shims always + `_local_` migrations). */
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

const FLAVORS: readonly DbFlavor[] = ['pglite', 'postgres', 'supabase'];

/**
 * Resolves the database flavor from the environment (see {@link DbEnv}).
 * @throws Error for an unknown `PACELINE_DB_FLAVOR`, or `postgres`/`supabase`
 *   without a `DATABASE_URL`.
 */
export function resolveDbFlavor(env: DbEnv = process.env): DbFlavor {
  const url = env.DATABASE_URL?.trim();
  const raw = env.PACELINE_DB_FLAVOR?.trim().toLowerCase();
  if (raw) {
    if (!(FLAVORS as readonly string[]).includes(raw)) {
      throw new Error(`PACELINE_DB_FLAVOR must be one of ${FLAVORS.join(', ')} (got "${env.PACELINE_DB_FLAVOR}")`);
    }
    const flavor = raw as DbFlavor;
    if (flavor !== 'pglite' && !url) throw new Error(`PACELINE_DB_FLAVOR=${flavor} needs DATABASE_URL`);
    return flavor;
  }
  if (!url) return 'pglite';
  return envFlag(env.PACELINE_DB_LOCAL) ? 'postgres' : 'supabase';
}

/**
 * Creates the database for this process from {@link resolveDbFlavor}: PGlite
 * at `PACELINE_DATA_DIR` (default `.pglite`; `memory` for an in-memory
 * database) for `pglite`, otherwise the `pg` adapter on `DATABASE_URL`.
 * Does not run migrations; call `migrate(db)`, which applies the Supabase
 * shims as the flavor requires.
 */
export async function createDb(env: DbEnv = process.env, options: CreateDbOptions = {}): Promise<Db> {
  const flavor = resolveDbFlavor(env);
  if (flavor === 'pglite') {
    return createPgliteDb({
      dataDir: resolveDataDir(env.PACELINE_DATA_DIR, options.cwd),
      ...(options.pgtap ? { pgtap: true } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }
  const url = env.DATABASE_URL!.trim();
  const listenUrl = env.DATABASE_LISTEN_URL?.trim();
  return createPgDb({
    connectionString: url,
    ...(listenUrl ? { listenConnectionString: listenUrl } : {}),
    local: envFlag(env.PACELINE_DB_LOCAL),
    flavor,
    ...(options.onError ? { onError: options.onError } : {}),
  });
}
