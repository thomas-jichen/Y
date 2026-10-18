/**
 * Runs supabase/tests/*.sql (pgTAP) on PGlite and reports structured results.
 *
 * Each file runs on its own fresh test database (shims + migrations + pgTAP
 * in schema `extensions`), as one simple-protocol query, so files may use
 * `begin; ... rollback;` and `set local role ...` freely. Files must be plain
 * SQL: psql meta-commands (`\i`, `\set`) are not supported. Output from
 * every single-column text result is parsed as TAP; an SQL error stops the
 * file and is reported with the TAP produced up to that point.
 */
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { protocol } from '@electric-sql/pglite';
import { paths } from './paths.js';
import { parseTap, type TapReport } from './tap.js';
import { createTestDb } from './testing.js';

/** Options for {@link runSqlTests} and {@link runSqlTestFile}. */
export interface SqlTestOptions {
  /** Directory of `*.sql` test files. Defaults to the repo's supabase/tests. */
  testsDir?: string;
  /** Migrations for the test databases. Defaults to supabase/migrations. */
  migrationsDir?: string;
  /** Only run files whose name passes this filter. */
  filter?: (name: string) => boolean;
}

/** An SQL error that stopped a test file. */
export interface SqlTestError {
  message: string;
  code: string | undefined;
  detail: string | undefined;
  hint: string | undefined;
  /** 1-based line in the test file, when Postgres reported a position. */
  line: number | undefined;
}

/** The result of one test file. */
export interface SqlTestFileResult {
  /** Absolute path. */
  file: string;
  /** File name, e.g. `rls_threads.sql`. */
  name: string;
  /** True when the TAP passed and no SQL error occurred. */
  ok: boolean;
  tap: TapReport;
  error: SqlTestError | null;
  /** NOTICE/WARNING messages raised while the file ran. */
  notices: string[];
  durationMs: number;
}

/** The result of a whole run. */
export interface SqlTestRunResult {
  ok: boolean;
  testsDir: string;
  files: SqlTestFileResult[];
  /** Files that passed / failed. */
  passed: number;
  failed: number;
  durationMs: number;
}

const TEXT_OID = 25;
const CREATES_PGTAP_RE = /\bcreate\s+extension\s+(?!if\s+not\s+exists\b)"?pgtap\b/i;

/** Lists `*.sql` files in `dir` (absolute paths, sorted). A missing directory is empty. */
export function listSqlTestFiles(dir: string = paths.sqlTestsDir): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => join(resolve(dir), entry.name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

interface ProtocolMessage {
  name: string;
  fields?: unknown[];
  fieldCount?: number;
  message?: string;
  code?: string;
  detail?: string;
  hint?: string;
  position?: string;
  severity?: string;
}

function lineOf(sql: string, position: string | undefined): number | undefined {
  const offset = Number(position);
  if (!Number.isInteger(offset) || offset < 1) return undefined;
  let line = 1;
  for (let i = 0; i < offset - 1 && i < sql.length; i++) if (sql[i] === '\n') line++;
  return line;
}

/** Runs one pgTAP file on a fresh test database. */
export async function runSqlTestFile(file: string, options: SqlTestOptions = {}): Promise<SqlTestFileResult> {
  const started = performance.now();
  const sql = await readFile(file, 'utf8');
  const lines: string[] = [];
  const notices: string[] = [];
  let error: SqlTestError | null = null;

  const db = await createTestDb({
    pgtap: true,
    ...(options.migrationsDir ? { migrationsDir: options.migrationsDir } : {}),
  });
  try {
    // pgTAP is preinstalled (in schema extensions); a file that runs a bare
    // `create extension pgtap` expects to install it itself.
    if (CREATES_PGTAP_RE.test(sql)) await db.exec('drop extension if exists pgtap');
    const { messages } = await db.pglite.runExclusive(() =>
      db.pglite.execProtocol(protocol.serialize.query(sql), { throwOnError: false }),
    );
    let tapColumn = false;
    for (const message of messages as ProtocolMessage[]) {
      switch (message.name) {
        case 'rowDescription': {
          const fields = (message.fields ?? []) as Array<{ dataTypeID: number }>;
          tapColumn = fields.length === 1 && fields[0]?.dataTypeID === TEXT_OID;
          break;
        }
        case 'dataRow': {
          const value = message.fields?.[0];
          if (tapColumn && typeof value === 'string') lines.push(value);
          break;
        }
        case 'notice':
          notices.push(`${message.severity ?? 'NOTICE'}: ${message.message ?? ''}`);
          break;
        case 'error':
          error ??= {
            message: message.message ?? 'unknown error',
            code: message.code,
            detail: message.detail,
            hint: message.hint,
            line: lineOf(sql, message.position),
          };
          break;
        default:
          break;
      }
    }
  } catch (thrown) {
    error ??= {
      message: thrown instanceof Error ? thrown.message : String(thrown),
      code: undefined,
      detail: undefined,
      hint: undefined,
      line: undefined,
    };
  } finally {
    await db.close();
  }

  const tap = parseTap(lines);
  return {
    file,
    name: basename(file),
    ok: tap.ok && error === null,
    tap,
    error,
    notices,
    durationMs: Math.round(performance.now() - started),
  };
}

/** Runs every test file (sequentially; each gets its own database). */
export async function runSqlTests(options: SqlTestOptions = {}): Promise<SqlTestRunResult> {
  const started = performance.now();
  const testsDir = resolve(options.testsDir ?? paths.sqlTestsDir);
  const filter = options.filter ?? (() => true);
  const files: SqlTestFileResult[] = [];
  for (const file of listSqlTestFiles(testsDir)) {
    if (!filter(basename(file))) continue;
    files.push(await runSqlTestFile(file, options));
  }
  const failed = files.filter((result) => !result.ok).length;
  return {
    ok: failed === 0,
    testsDir,
    files,
    passed: files.length - failed,
    failed,
    durationMs: Math.round(performance.now() - started),
  };
}

/** `path` relative to `root` when it is inside it, else absolute. */
function displayPath(path: string, root: string): string {
  const rel = relative(root, path);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? path : rel;
}

/** Human-readable TAP for one file: its TAP lines, then a status line and any problems. */
export function formatSqlTestFile(result: SqlTestFileResult, root: string = paths.repoRoot): string {
  const out: string[] = [`# ${displayPath(result.file, root)}`, ...result.tap.lines];
  for (const notice of result.notices) out.push(`# ${notice}`);
  if (result.error) {
    const where = result.error.line ? ` (line ${result.error.line})` : '';
    out.push(`# SQL error${where}: ${result.error.message}${result.error.code ? ` [${result.error.code}]` : ''}`);
    if (result.error.detail) out.push(`#   detail: ${result.error.detail}`);
    if (result.error.hint) out.push(`#   hint: ${result.error.hint}`);
  }
  for (const problem of result.tap.problems) out.push(`# problem: ${problem}`);
  const plan = result.tap.plan;
  const total = plan ? Math.max(plan.end - plan.start + 1, result.tap.assertions.length) : result.tap.assertions.length;
  out.push(
    `# ${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.tap.passed}/${total} passed` +
      `${result.tap.skipped ? `, ${result.tap.skipped} skipped` : ''}${result.tap.todo ? `, ${result.tap.todo} todo` : ''}` +
      ` (${result.durationMs} ms)`,
  );
  return out.join('\n');
}

/** Human-readable report for a run: every file, then a summary line. */
export function formatSqlTestRun(run: SqlTestRunResult, root: string = paths.repoRoot): string {
  if (run.files.length === 0) return `# no SQL test files in ${displayPath(run.testsDir, root)}`;
  const parts = run.files.map((file) => formatSqlTestFile(file, root));
  parts.push(
    `# ${run.ok ? 'PASS' : 'FAIL'}: ${run.passed}/${run.files.length} file${run.files.length === 1 ? '' : 's'} passed (${run.durationMs} ms)`,
  );
  return parts.join('\n\n');
}
