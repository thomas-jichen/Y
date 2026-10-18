/**
 * Migration runner for supabase/migrations.
 *
 * - Applies `*.sql` files in lexical order, each in its own transaction, and
 *   records `{name, sha256}` in `paceline_meta.migrations`.
 * - Refuses to run when an applied file's contents changed (hash mismatch):
 *   write a new migration instead of editing an applied one.
 * - Files whose name contains `_local_` are applied only on local databases
 *   (PGlite, or Postgres flagged local).
 * - The built-in Supabase shims (`local-shims.sql`) run first, by flavor:
 *   always on PGlite and on local databases, on a plain Postgres
 *   (`flavor: 'postgres'`) when its `auth` schema is missing or is the shims'
 *   own, and never on Supabase.
 * - Safe to run from several processes at once: each step takes a
 *   transaction-scoped advisory lock and re-checks what is applied.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DbError, sqlState } from './errors.js';
import { paths } from './paths.js';
import type { Db, Queryable } from './types.js';

/** Marker in a file name that makes a migration local-only. */
export const LOCAL_ONLY_MARKER = '_local_';

/** Advisory lock key shared by every migrate step. */
export const MIGRATION_LOCK_KEY = 'paceline_meta.migrations';

/** A migration file on disk. */
export interface MigrationFile {
  /** File name, e.g. `0001_identity.sql`. This is the key in `paceline_meta.migrations`. */
  name: string;
  /** Absolute path. */
  path: string;
  /** File contents. */
  sql: string;
  /** sha256 (hex) of the contents with CRLF normalized to LF. */
  sha256: string;
  /** True when the name contains `_local_`. */
  localOnly: boolean;
}

/** A row of `paceline_meta.migrations`. */
export interface AppliedMigration {
  name: string;
  sha256: string;
  appliedAt: Date;
}

/** Options for {@link migrate} and {@link migrationStatus}. */
export interface MigrateOptions {
  /**
   * Directory of `*.sql` migrations. Defaults to the repo's
   * supabase/migrations, which may be absent (treated as empty). An explicit
   * directory must exist.
   */
  migrationsDir?: string;
  /** Apply local-only files (and force the shims on). Defaults to `db.local`. */
  local?: boolean;
  /**
   * Apply the built-in Supabase shims first: `true`, `false`, or `'auto'`
   * (only when the `auth` schema is missing or carries the shims' marker
   * comment). Defaults to `true` when `local`, `'auto'` for
   * `db.flavor === 'postgres'`, else `false`.
   */
  shims?: boolean | 'auto';
  /** Progress lines (one per applied file). Default: silent. */
  log?: (line: string) => void;
}

/** What {@link migrate} did. */
export interface MigrateResult {
  /** Whether local-only files were considered. */
  local: boolean;
  /** Whether the built-in shims were applied. */
  shimsApplied: boolean;
  /** Files applied by this run, in order. */
  applied: string[];
  /** Files that were already applied (hash verified). */
  alreadyApplied: string[];
  /** `_local_` files skipped because the database is not local. */
  skippedLocalOnly: string[];
  /** Recorded migrations whose file no longer exists. Reported, not an error. */
  missingFiles: string[];
}

/** Pending/applied state, from {@link migrationStatus}. */
export interface MigrationStatus {
  local: boolean;
  applied: AppliedMigration[];
  /** Files that would be applied, in order. */
  pending: string[];
  /** Applied files whose contents changed since. `migrate()` refuses while this is non-empty. */
  changed: HashMismatch[];
  skippedLocalOnly: string[];
  missingFiles: string[];
}

/** One applied migration whose file changed. */
export interface HashMismatch {
  name: string;
  recorded: string;
  current: string;
}

/** Thrown when applied migration files were edited. Nothing is applied. */
export class MigrationHashMismatchError extends DbError {
  override readonly name = 'MigrationHashMismatchError';
  readonly mismatches: HashMismatch[];
  constructor(mismatches: HashMismatch[]) {
    super(
      `applied migration(s) changed on disk: ${mismatches.map((m) => m.name).join(', ')}. ` +
        'Applied migrations are immutable; revert the edit and add a new migration instead.',
    );
    this.mismatches = mismatches;
  }
}

/** Thrown when a migration file fails to apply. Its transaction was rolled back. */
export class MigrationFailedError extends DbError {
  override readonly name = 'MigrationFailedError';
  /** The failing file name (or `local-shims.sql`). */
  readonly file: string;
  /** SQLSTATE of the underlying error, if any. */
  readonly code: string | undefined;
  constructor(file: string, cause: unknown, sql?: string) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const line = sql ? errorLine(cause, sql) : undefined;
    super(`migration ${file} failed${line ? ` at line ${line}` : ''}: ${message}`, { cause });
    this.file = file;
    this.code = sqlState(cause);
  }
}

/** Thrown when a migration contains BEGIN/COMMIT/ROLLBACK; the runner owns the transaction. */
export class MigrationTransactionControlError extends DbError {
  override readonly name = 'MigrationTransactionControlError';
}

/** sha256 (hex) of migration SQL, with CRLF normalized to LF so checkouts on any OS agree. */
export function hashSql(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** True for file names that contain `_local_`. */
export function isLocalOnlyMigration(name: string): boolean {
  return name.includes(LOCAL_ONLY_MARKER);
}

/**
 * Reads `*.sql` files from `dir`, sorted lexically by name.
 * @param required when false, a missing directory reads as empty.
 */
export async function loadMigrationFiles(dir: string, required = true): Promise<MigrationFile[]> {
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      const sql = await readFile(path, 'utf8');
      return { name, path, sql, sha256: hashSql(sql), localOnly: isLocalOnlyMigration(name) };
    }),
  );
}

/** The SQL of the built-in Supabase shims (packages/db/src/local-shims.sql). */
export async function readLocalShims(): Promise<string> {
  return readFile(paths.localShims, 'utf8');
}

/** Comment prefix the shims put on the schemas they create (`auth`, `realtime`). */
export const LOCAL_SHIM_MARKER = 'paceline local shim';

/**
 * True when the shims belong on this database: its `auth` schema is missing,
 * or it was created by the shims (comment starts with {@link LOCAL_SHIM_MARKER}).
 * False for a real Supabase database.
 */
export async function needsLocalShims(q: Queryable): Promise<boolean> {
  const { rows } = await q.query<{ needed: boolean }>(
    `select to_regnamespace('auth') is null
         or coalesce(obj_description(to_regnamespace('auth')::oid, 'pg_namespace'), '') like $1 as needed`,
    [`${LOCAL_SHIM_MARKER}%`],
  );
  return rows[0]?.needed === true;
}

/** Applies the built-in Supabase shims in one transaction. Idempotent. */
export async function applyLocalShims(db: Db): Promise<void> {
  const sql = await readLocalShims();
  try {
    await db.tx(async (tx) => {
      await lock(tx);
      await tx.exec(sql);
    });
  } catch (error) {
    throw new MigrationFailedError('local-shims.sql', error, sql);
  }
}

const META_DDL = `
create schema if not exists paceline_meta;
revoke all on schema paceline_meta from public;
create table if not exists paceline_meta.migrations (
  name text primary key,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
);
alter table paceline_meta.migrations enable row level security;
revoke all on table paceline_meta.migrations from public;
`;

async function lock(q: Queryable): Promise<void> {
  await q.query('select pg_advisory_xact_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);
}

/** Creates `paceline_meta.migrations` if needed. */
export async function ensureMigrationsTable(db: Db): Promise<void> {
  await db.tx(async (tx) => {
    await lock(tx);
    await tx.exec(META_DDL);
  });
}

/** Rows of `paceline_meta.migrations`, by name. Empty when the table does not exist yet. */
export async function listAppliedMigrations(q: Queryable): Promise<AppliedMigration[]> {
  const exists = await q.query<{ exists: boolean }>(
    "select to_regclass('paceline_meta.migrations') is not null as exists",
  );
  if (!exists.rows[0]?.exists) return [];
  const result = await q.query<{ name: string; sha256: string; applied_at: Date }>(
    'select name, sha256, applied_at from paceline_meta.migrations order by name',
  );
  return result.rows.map((row) => ({ name: row.name, sha256: row.sha256, appliedAt: row.applied_at }));
}

const TX_CONTROL = new Set([
  'begin',
  'begin work',
  'begin transaction',
  'start transaction',
  'commit',
  'commit work',
  'commit transaction',
  'end',
  'end work',
  'end transaction',
  'rollback',
  'rollback work',
  'rollback transaction',
  'abort',
]);

/**
 * Finds a top-level transaction-control statement (BEGIN, COMMIT, ...),
 * skipping comments, quoted strings and dollar-quoted bodies.
 * @returns the 1-based line of the first one, or undefined.
 */
export function findTransactionControl(sql: string): number | undefined {
  let statement = '';
  let statementLine = 1;
  let line = 1;
  let i = 0;
  const append = (token: string): void => {
    if (statement.trim() === '' && token.trim() !== '') statementLine = line;
    statement += token;
  };
  const check = (): number | undefined => {
    const normalized = statement.trim().replace(/\s+/g, ' ').toLowerCase();
    return TX_CONTROL.has(normalized) || /^(begin|start transaction)\b.*\bisolation level\b/.test(normalized)
      ? statementLine
      : undefined;
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      line += countNewlines(sql, i, stop);
      append(' ');
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // E'...' strings allow backslash escapes.
      const escapes = ch === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j++;
      }
      append('x');
      line += countNewlines(sql, i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? sql.length : end + tag[0].length;
        append('x');
        line += countNewlines(sql, i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ';') {
      const found = check();
      if (found !== undefined) return found;
      statement = '';
      i++;
      continue;
    }
    append(ch);
    if (ch === '\n') line++;
    i++;
  }
  return check();
}

function countNewlines(text: string, from: number, to: number): number {
  let n = 0;
  for (let k = from; k < to && k < text.length; k++) if (text[k] === '\n') n++;
  return n;
}

/** The 1-based line of a Postgres error's `position` within `sql`, if known. */
function errorLine(error: unknown, sql: string): number | undefined {
  const position = Number((error as { position?: unknown } | null)?.position);
  if (!Number.isInteger(position) || position < 1) return undefined;
  return countNewlines(sql, 0, Math.min(position - 1, sql.length)) + 1;
}

interface Plan {
  local: boolean;
  shims: boolean | 'auto';
  files: MigrationFile[];
  skippedLocalOnly: string[];
  applied: AppliedMigration[];
  changed: HashMismatch[];
  missingFiles: string[];
}

async function plan(db: Db, options: MigrateOptions): Promise<Plan> {
  const local = options.local ?? db.local;
  const shims = options.shims ?? (local ? true : db.flavor === 'postgres' ? 'auto' : false);
  const explicit = options.migrationsDir !== undefined;
  const dir = resolve(options.migrationsDir ?? paths.migrationsDir);
  const all = await loadMigrationFiles(dir, explicit);
  const files = all.filter((file) => local || !file.localOnly);
  const skippedLocalOnly = all.filter((file) => !local && file.localOnly).map((file) => file.name);
  const applied = await listAppliedMigrations(db);
  const byName = new Map(all.map((file) => [file.name, file]));
  const changed: HashMismatch[] = [];
  const missingFiles: string[] = [];
  for (const row of applied) {
    const file = byName.get(row.name);
    if (!file) missingFiles.push(row.name);
    else if (file.sha256 !== row.sha256) changed.push({ name: row.name, recorded: row.sha256, current: file.sha256 });
  }
  return { local, shims, files, skippedLocalOnly, applied, changed, missingFiles };
}

/** Reports applied, pending and changed migrations without changing anything. */
export async function migrationStatus(db: Db, options: MigrateOptions = {}): Promise<MigrationStatus> {
  const p = await plan(db, options);
  const appliedNames = new Set(p.applied.map((row) => row.name));
  return {
    local: p.local,
    applied: p.applied,
    pending: p.files.filter((file) => !appliedNames.has(file.name)).map((file) => file.name),
    changed: p.changed,
    skippedLocalOnly: p.skippedLocalOnly,
    missingFiles: p.missingFiles,
  };
}

/**
 * Applies pending migrations (and, on local databases, the Supabase shims).
 * @throws MigrationHashMismatchError before applying anything if an applied file changed.
 * @throws MigrationTransactionControlError if a pending file contains BEGIN/COMMIT/ROLLBACK.
 * @throws MigrationFailedError if a file fails; earlier files stay applied.
 */
export async function migrate(db: Db, options: MigrateOptions = {}): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const p = await plan(db, options);
  if (p.changed.length > 0) throw new MigrationHashMismatchError(p.changed);

  const appliedNames = new Set(p.applied.map((row) => row.name));
  const pending = p.files.filter((file) => !appliedNames.has(file.name));
  for (const file of pending) {
    const line = findTransactionControl(file.sql);
    if (line !== undefined) {
      throw new MigrationTransactionControlError(
        `migration ${file.name} line ${line}: transaction control (BEGIN/COMMIT/ROLLBACK) is not allowed; ` +
          'the runner wraps each file in its own transaction',
      );
    }
  }

  const shimsApplied = p.shims === 'auto' ? await needsLocalShims(db) : p.shims;
  await ensureMigrationsTable(db);
  if (shimsApplied) {
    await applyLocalShims(db);
    log('applied local-shims.sql');
  }

  const result: MigrateResult = {
    local: p.local,
    shimsApplied,
    applied: [],
    alreadyApplied: p.files.filter((file) => appliedNames.has(file.name)).map((file) => file.name),
    skippedLocalOnly: p.skippedLocalOnly,
    missingFiles: p.missingFiles,
  };

  for (const file of pending) {
    const outcome = await applyOne(db, file);
    if (outcome === 'applied') {
      result.applied.push(file.name);
      log(`applied ${file.name}`);
    } else {
      result.alreadyApplied.push(file.name);
    }
  }

  await db.refreshTypes();
  return result;
}

async function applyOne(db: Db, file: MigrationFile): Promise<'applied' | 'already-applied'> {
  try {
    return await db.tx(async (tx) => {
      await lock(tx);
      // Another process may have applied it while we waited for the lock.
      const existing = await tx.query<{ sha256: string }>(
        'select sha256 from paceline_meta.migrations where name = $1',
        [file.name],
      );
      const recorded = existing.rows[0]?.sha256;
      if (recorded !== undefined) {
        if (recorded !== file.sha256) {
          throw new MigrationHashMismatchError([{ name: file.name, recorded, current: file.sha256 }]);
        }
        return 'already-applied';
      }
      await tx.exec(file.sql);
      // A migration must not leave the session in another role (pooled connections are reused).
      await tx.exec('reset role');
      await tx.query('insert into paceline_meta.migrations (name, sha256) values ($1, $2)', [file.name, file.sha256]);
      return 'applied';
    });
  } catch (error) {
    if (error instanceof MigrationHashMismatchError) throw error;
    throw new MigrationFailedError(file.name, error, file.sql);
  }
}
