/**
 * paceline-db CLI.
 *
 *   tsx src/cli.ts migrate  [--migrations-dir <dir>] [--local] [--flavor <f>]
 *   tsx src/cli.ts status   [--migrations-dir <dir>] [--local] [--flavor <f>]
 *   tsx src/cli.ts test-sql [--tests-dir <dir>] [--migrations-dir <dir>] [--filter <substring>]
 *
 * `migrate` and `status` use createDb(env): PGlite at PACELINE_DATA_DIR
 * unless DATABASE_URL is set, then Postgres with PACELINE_DB_FLAVOR
 * (`supabase` by default: no shims; `postgres`: shims when auth is missing).
 * `test-sql` always uses fresh in-memory PGlite databases and exits 1 when
 * any file fails.
 *
 * When run directly, variables from the repo-root `.env` are loaded first
 * (without overriding variables already set).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { createDb, type DbEnv } from './create.js';
import { migrate, migrationStatus } from './migrate.js';
import { paths, resolveDataDir } from './paths.js';
import { formatSqlTestRun, runSqlTests } from './sqltest.js';
import type { Db, DbFlavor } from './types.js';

/** Where the CLI writes, and what it reads. Injected by tests. */
export interface CliIo {
  env: DbEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd?: string;
}

const USAGE = `usage: paceline-db <command> [options]

commands:
  migrate    apply pending supabase/migrations (Postgres if DATABASE_URL is set, else PGlite)
  status     show applied, pending and changed migrations
  test-sql   run supabase/tests/*.sql (pgTAP) on fresh PGlite databases; exit 1 on failure

options:
  --migrations-dir <dir>   migrations directory (default: supabase/migrations)
  --tests-dir <dir>        pgTAP tests directory (default: supabase/tests)
  --filter <text>          test-sql: only files whose name contains <text>
  --local                  treat a Postgres DATABASE_URL as local (shims + _local_ files)
  --flavor <f>             pglite | postgres | supabase (overrides PACELINE_DB_FLAVOR)
  -h, --help               show this help`;

interface ParsedArgs {
  command: string | undefined;
  migrationsDir: string | undefined;
  testsDir: string | undefined;
  filter: string | undefined;
  local: boolean;
  flavor: string | undefined;
  help: boolean;
}

/** Parses CLI arguments. @throws Error on unknown flags or missing values. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: undefined,
    migrationsDir: undefined,
    testsDir: undefined,
    filter: undefined,
    local: false,
    flavor: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case '--migrations-dir':
        args.migrationsDir = value();
        break;
      case '--tests-dir':
        args.testsDir = value();
        break;
      case '--filter':
        args.filter = value();
        break;
      case '--local':
        args.local = true;
        break;
      case '--flavor':
        args.flavor = value();
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        if (args.command !== undefined) throw new Error(`unexpected argument ${arg}`);
        args.command = arg;
    }
  }
  return args;
}

function describeTarget(env: DbEnv, cwd: string, flavor: DbFlavor): string {
  if (flavor !== 'pglite' && env.DATABASE_URL?.trim()) {
    try {
      const url = new URL(env.DATABASE_URL.trim());
      return `${flavor} ${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
    } catch {
      return `${flavor} (DATABASE_URL)`;
    }
  }
  return `pglite ${resolveDataDir(env.PACELINE_DATA_DIR, cwd)}`;
}

/**
 * Runs the CLI and returns the exit code (0 ok, 1 failure, 2 usage error).
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help || args.command === undefined) {
    (args.help ? io.stdout : io.stderr)(USAGE);
    return args.help ? 0 : 2;
  }
  const cwd = io.cwd ?? process.cwd();
  const migrationsDir = args.migrationsDir ? resolve(cwd, args.migrationsDir) : undefined;

  switch (args.command) {
    case 'migrate':
    case 'status': {
      const env: DbEnv = {
        ...io.env,
        ...(args.local ? { PACELINE_DB_LOCAL: '1' } : {}),
        ...(args.flavor ? { PACELINE_DB_FLAVOR: args.flavor } : {}),
      };
      let db: Db;
      try {
        db = await createDb(env, { cwd });
      } catch (error) {
        io.stderr(`error: could not open the database: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      try {
        const local = db.local;
        io.stdout(`# ${describeTarget(env, cwd, db.flavor)}${local ? ' (local)' : ''}`);
        const options = { local, ...(migrationsDir ? { migrationsDir } : {}) };
        if (args.command === 'migrate') {
          const result = await migrate(db, { ...options, log: (line) => io.stdout(line) });
          for (const name of result.skippedLocalOnly) io.stdout(`skipped ${name} (local only)`);
          for (const name of result.missingFiles) io.stdout(`warning: ${name} is recorded as applied but the file is missing`);
          io.stdout(
            `# ${result.applied.length} applied, ${result.alreadyApplied.length} already applied` +
              `${result.skippedLocalOnly.length ? `, ${result.skippedLocalOnly.length} local-only skipped` : ''}`,
          );
        } else {
          const status = await migrationStatus(db, options);
          for (const row of status.applied) io.stdout(`applied  ${row.name}  ${row.appliedAt.toISOString()}`);
          for (const name of status.pending) io.stdout(`pending  ${name}`);
          for (const change of status.changed) io.stdout(`CHANGED  ${change.name}  (recorded ${change.recorded.slice(0, 12)}, now ${change.current.slice(0, 12)})`);
          for (const name of status.skippedLocalOnly) io.stdout(`skipped  ${name}  (local only)`);
          for (const name of status.missingFiles) io.stdout(`missing  ${name}`);
          if (status.changed.length > 0) return 1;
        }
        return 0;
      } catch (error) {
        io.stderr(`error: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      } finally {
        await db.close();
      }
    }
    case 'test-sql': {
      try {
        const run = await runSqlTests({
          ...(args.testsDir ? { testsDir: resolve(cwd, args.testsDir) } : {}),
          ...(migrationsDir ? { migrationsDir } : {}),
          ...(args.filter ? { filter: (name: string) => name.includes(args.filter!) } : {}),
        });
        io.stdout(formatSqlTestRun(run));
        return run.ok ? 0 : 1;
      } catch (error) {
        io.stderr(`error: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    }
    default:
      io.stderr(`unknown command ${args.command}\n\n${USAGE}`);
      return 2;
  }
}

/** Loads `file` into `env` without overriding variables that are already set. */
export function loadEnvFile(file: string, env: Record<string, string | undefined> = process.env): void {
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined && value !== undefined) env[key] = value;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  loadEnvFile(join(paths.repoRoot, '.env'));
  const code = await runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  });
  process.exitCode = code;
}
