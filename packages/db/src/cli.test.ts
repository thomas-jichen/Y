import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile, parseArgs, runCli, type CliIo } from './cli.js';

let root: string;

function io(env: CliIo['env'] = {}): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { env, cwd: root, out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'y-cli-'));
  await mkdir(join(root, 'migrations'));
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'migrations', '0001_a.sql'), 'create table public.a (id int);');
  await writeFile(join(root, 'migrations', '0002_local_seed.sql'), 'insert into public.a values (1);');
  await writeFile(join(root, 'tests', 'ok.sql'), "select plan(1); select ok(true, 'fine'); select * from finish();");
  await writeFile(join(root, 'tests', 'bad.sql'), "select plan(1); select ok(false, 'broken'); select * from finish();");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('parses commands and flags', () => {
    expect(parseArgs(['migrate', '--migrations-dir', 'm', '--local'])).toMatchObject({
      command: 'migrate',
      migrationsDir: 'm',
      local: true,
    });
    expect(parseArgs(['migrate', '--flavor', 'postgres'])).toMatchObject({ command: 'migrate', flavor: 'postgres' });
    expect(parseArgs(['test-sql', '--tests-dir', 't', '--filter', 'rls'])).toMatchObject({
      command: 'test-sql',
      testsDir: 't',
      filter: 'rls',
    });
    expect(() => parseArgs(['migrate', '--bogus'])).toThrow(/unknown option/);
    expect(() => parseArgs(['migrate', '--tests-dir'])).toThrow(/needs a value/);
    expect(() => parseArgs(['migrate', 'extra'])).toThrow(/unexpected argument/);
  });
});

describe('runCli', () => {
  it('prints usage', async () => {
    const help = io();
    expect(await runCli(['--help'], help)).toBe(0);
    expect(help.out.join('\n')).toMatch(/usage: y-db/);
    const none = io();
    expect(await runCli([], none)).toBe(2);
    const unknown = io();
    expect(await runCli(['nope'], unknown)).toBe(2);
    expect(unknown.err.join('\n')).toMatch(/unknown command nope/);
  });

  it('migrate applies migrations to a PGlite data dir; status reports them', async () => {
    const env = { Y_DATA_DIR: join(root, 'pgdata') };
    const first = io(env);
    expect(await runCli(['migrate', '--migrations-dir', 'migrations'], first)).toBe(0);
    expect(first.out).toEqual([
      `# pglite ${join(root, 'pgdata')} (local)`,
      'applied local-shims.sql',
      'applied 0001_a.sql',
      'applied 0002_local_seed.sql',
      '# 2 applied, 0 already applied',
    ]);
    const second = io(env);
    expect(await runCli(['migrate', '--migrations-dir', 'migrations'], second)).toBe(0);
    expect(second.out.at(-1)).toBe('# 0 applied, 2 already applied');
    const status = io(env);
    expect(await runCli(['status', '--migrations-dir', 'migrations'], status)).toBe(0);
    expect(status.out.filter((l) => l.startsWith('applied')).map((l) => l.split(/\s+/)[1])).toEqual([
      '0001_a.sql',
      '0002_local_seed.sql',
    ]);
  });

  it('migrate exits 1 with a message when something is wrong', async () => {
    const bad = io({ Y_DATA_DIR: 'memory' });
    expect(await runCli(['migrate', '--migrations-dir', 'does-not-exist'], bad)).toBe(1);
    expect(bad.err.join('\n')).toMatch(/^error: .*ENOENT/);
  });

  it('test-sql prints TAP and exits 1 when a file fails', async () => {
    const run = io();
    expect(await runCli(['test-sql', '--tests-dir', 'tests', '--migrations-dir', 'migrations'], run)).toBe(1);
    const text = run.out.join('\n');
    expect(text).toContain('ok 1 - fine');
    expect(text).toContain('not ok 1 - broken');
    expect(text).toMatch(/# FAIL: 1\/2 files passed/);
  });

  it('test-sql exits 0 when everything passes (or nothing matches)', async () => {
    const run = io();
    expect(await runCli(['test-sql', '--tests-dir', 'tests', '--migrations-dir', 'migrations', '--filter', 'ok'], run)).toBe(0);
    expect(run.out.join('\n')).toMatch(/# PASS: 1\/1 file passed/);
    const empty = io();
    expect(await runCli(['test-sql', '--tests-dir', 'nothing-here'], empty)).toBe(0);
    expect(empty.out.join('\n')).toMatch(/no SQL test files/);
  });
});

describe('loadEnvFile', () => {
  it('loads variables without overriding existing ones', async () => {
    const file = join(root, '.env');
    await writeFile(file, 'A=from-file\nB=from-file\n# comment\nC="quoted value"\n');
    const env: Record<string, string | undefined> = { A: 'already-set' };
    loadEnvFile(file, env);
    expect(env).toEqual({ A: 'already-set', B: 'from-file', C: 'quoted value' });
    loadEnvFile(join(root, 'missing.env'), env);
  });
});
