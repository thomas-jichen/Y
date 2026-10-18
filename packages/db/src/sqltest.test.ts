import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatSqlTestRun, listSqlTestFiles, runSqlTestFile, runSqlTests } from './sqltest.js';

let root: string;
let migrations: string;
let tests: string;

const ALICE = '0b6f3c1e-1d2a-4c5b-8e9f-0a1b2c3d4e5f';
const BOB = '9e8d7c6b-5a49-4382-9172-6f5e4d3c2b1a';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'y-sqltest-'));
  migrations = join(root, 'migrations');
  tests = join(root, 'tests');
  await mkdir(migrations, { recursive: true });
  await mkdir(tests, { recursive: true });
  await writeFile(
    join(migrations, '0001_notes.sql'),
    `create table public.notes (id serial primary key, owner_id uuid not null, body text not null);
     alter table public.notes enable row level security;
     create policy notes_owner on public.notes for select to authenticated using (owner_id = auth.uid());`,
  );
  await writeFile(
    join(tests, '01_rls_pass.sql'),
    `begin;
     select plan(4);
     select has_table('public', 'notes', 'notes exists');
     select ok((select relrowsecurity from pg_class where oid = 'public.notes'::regclass), 'rls enabled on notes');
     insert into public.notes (owner_id, body) values ('${ALICE}', 'a'), ('${BOB}', 'b');
     set local role authenticated;
     select set_config('request.jwt.claims', '{"sub":"${ALICE}","role":"authenticated"}', true);
     select is((select count(*)::int from public.notes), 1, 'alice sees only her note');
     select results_eq('select body from public.notes', $$values ('a'::text)$$, 'and it is hers');
     select * from finish();
     rollback;`,
  );
  await writeFile(
    join(tests, '02_fail.sql'),
    `select plan(2);
     select ok(true, 'fine');
     select is(1 + 1, 3, 'math is broken');
     select * from finish();`,
  );
  await writeFile(
    join(tests, '03_error.sql'),
    `select plan(3);
     select ok(true, 'before the error');

     select * from public.no_such_table;
     select ok(true, 'never reached');`,
  );
  await writeFile(join(tests, '04_no_plan.sql'), `select ok(true, 'unplanned');`);
  await writeFile(join(tests, 'README.md'), 'not a test');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('listSqlTestFiles', () => {
  it('lists only .sql files, sorted, and treats a missing directory as empty', () => {
    expect(listSqlTestFiles(tests).map((f) => f.slice(tests.length + 1))).toEqual([
      '01_rls_pass.sql',
      '02_fail.sql',
      '03_error.sql',
      '04_no_plan.sql',
    ]);
    expect(listSqlTestFiles(join(root, 'missing'))).toEqual([]);
  });
});

describe('runSqlTestFile', () => {
  it('passes a pgTAP file that checks RLS as a user', async () => {
    const result = await runSqlTestFile(join(tests, '01_rls_pass.sql'), { migrationsDir: migrations });
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.tap.passed).toBe(4);
    expect(result.tap.lines).toEqual([
      '1..4',
      'ok 1 - notes exists',
      'ok 2 - rls enabled on notes',
      'ok 3 - alice sees only her note',
      'ok 4 - and it is hers',
    ]);
  });

  it('reports failing assertions with diagnostics', async () => {
    const result = await runSqlTestFile(join(tests, '02_fail.sql'), { migrationsDir: migrations });
    expect(result.ok).toBe(false);
    expect(result.error).toBeNull();
    expect(result.tap.failed).toBe(1);
    const failed = result.tap.assertions.find((a) => !a.ok)!;
    expect(failed.description).toBe('math is broken');
    expect(failed.diagnostics.join('\n')).toMatch(/have: 2[\s\S]*want: 3/);
  });

  it('keeps the TAP produced before an SQL error and reports the error line', async () => {
    const result = await runSqlTestFile(join(tests, '03_error.sql'), { migrationsDir: migrations });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: '42P01', line: 4 });
    expect(result.error!.message).toMatch(/no_such_table/);
    expect(result.tap.lines).toEqual(['1..3', 'ok 1 - before the error']);
  });

  it('fails a file without a plan', async () => {
    const result = await runSqlTestFile(join(tests, '04_no_plan.sql'), { migrationsDir: migrations });
    expect(result.ok).toBe(false);
    // pgTAP itself refuses to run a test before plan().
    expect(result.error?.message).toMatch(/without a plan/);
    expect(result.tap.problems).toEqual(['no plan and no tests']);
  });
});

describe('runSqlTests', () => {
  it('runs every file on its own database and summarizes', async () => {
    const run = await runSqlTests({ testsDir: tests, migrationsDir: migrations });
    expect(run.files.map((f) => [f.name, f.ok])).toEqual([
      ['01_rls_pass.sql', true],
      ['02_fail.sql', false],
      ['03_error.sql', false],
      ['04_no_plan.sql', false],
    ]);
    expect([run.ok, run.passed, run.failed]).toEqual([false, 1, 3]);
    const text = formatSqlTestRun(run, root);
    expect(text).toContain('# tests/01_rls_pass.sql');
    expect(text).toContain('# PASS 01_rls_pass.sql: 4/4 passed');
    expect(text).toContain('# FAIL 02_fail.sql: 1/2 passed');
    expect(text).toMatch(/# SQL error \(line 4\): relation "public.no_such_table" does not exist \[42P01\]/);
    expect(text).toContain('# FAIL 03_error.sql: 1/3 passed');
    expect(text).toContain('# problem: no plan and no tests');
    expect(text.trim().split('\n').at(-1)).toMatch(/^# FAIL: 1\/4 files passed/);
  });

  it('filters files and passes on an empty selection', async () => {
    const run = await runSqlTests({ testsDir: tests, migrationsDir: migrations, filter: (name) => name.startsWith('01') });
    expect(run.files.map((f) => f.name)).toEqual(['01_rls_pass.sql']);
    expect(run.ok).toBe(true);
    const none = await runSqlTests({ testsDir: join(root, 'missing'), migrationsDir: migrations });
    expect(none).toMatchObject({ ok: true, files: [], passed: 0, failed: 0 });
    expect(formatSqlTestRun(none, root)).toBe('# no SQL test files in missing');
  });
});

describe('pgTAP installation', () => {
  it('supports files that create the extension themselves, with or without IF NOT EXISTS', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'y-sqltest-ext-'));
    try {
      await writeFile(
        join(dir, 'a.sql'),
        "begin;\ncreate extension pgtap;\nselect plan(1);\nselect ok(true, 'bare');\nselect * from finish();\nrollback;",
      );
      await writeFile(
        join(dir, 'b.sql'),
        "create extension if not exists pgtap with schema extensions;\nselect plan(1);\nselect ok(true, 'guarded');\nselect * from finish();",
      );
      const run = await runSqlTests({ testsDir: dir, migrationsDir: migrations });
      expect(run.files.map((f) => [f.name, f.ok, f.error?.message ?? null])).toEqual([
        ['a.sql', true, null],
        ['b.sql', true, null],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
