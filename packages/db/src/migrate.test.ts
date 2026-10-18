import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MigrationFailedError,
  MigrationHashMismatchError,
  MigrationTransactionControlError,
  findTransactionControl,
  hashSql,
  isLocalOnlyMigration,
  listAppliedMigrations,
  loadMigrationFiles,
  LOCAL_SHIM_MARKER,
  migrate,
  migrationStatus,
  needsLocalShims,
} from './migrate.js';
import { createPgliteDb, type PgliteDb } from './pglite.js';

let dir: string;
let db: PgliteDb;

async function write(name: string, sql: string): Promise<void> {
  await writeFile(join(dir, name), sql);
}

async function tables(): Promise<string[]> {
  const { rows } = await db.query<{ t: string }>(
    "select table_name as t from information_schema.tables where table_schema = 'public' order by 1",
  );
  return rows.map((r) => r.t);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'y-migrations-'));
  db = await createPgliteDb();
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('loading files', () => {
  it('reads *.sql files in lexical order with hashes', async () => {
    await write('0002_b.sql', 'select 2;');
    await write('0001_a.sql', 'select 1;');
    await write('0010_c.sql', 'select 10;');
    await write('README.md', '# not a migration');
    const files = await loadMigrationFiles(dir);
    expect(files.map((f) => f.name)).toEqual(['0001_a.sql', '0002_b.sql', '0010_c.sql']);
    expect(files[0]!.sha256).toBe(hashSql('select 1;'));
    expect(files[0]!.path).toBe(join(dir, '0001_a.sql'));
  });

  it('hashes CRLF and LF checkouts identically', () => {
    expect(hashSql('create table a (x int);\r\nselect 1;\r\n')).toBe(hashSql('create table a (x int);\nselect 1;\n'));
    expect(hashSql('select 1;')).not.toBe(hashSql('select 2;'));
    expect(hashSql('')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats a missing directory as empty only when not required', async () => {
    await expect(loadMigrationFiles(join(dir, 'missing'), false)).resolves.toEqual([]);
    await expect(loadMigrationFiles(join(dir, 'missing'))).rejects.toThrow(/ENOENT/);
  });

  it('recognizes local-only names', () => {
    expect(isLocalOnlyMigration('0000_local_shims.sql')).toBe(true);
    expect(isLocalOnlyMigration('0001_identity.sql')).toBe(false);
    expect(isLocalOnlyMigration('0001_locale.sql')).toBe(false);
  });
});

describe('migrate', () => {
  it('handles an empty migrations folder', async () => {
    const result = await migrate(db, { migrationsDir: dir });
    expect(result).toMatchObject({ local: true, shimsApplied: true, applied: [], alreadyApplied: [] });
    expect(await listAppliedMigrations(db)).toEqual([]);
  });

  it('errors on an explicit directory that does not exist', async () => {
    await expect(migrate(db, { migrationsDir: join(dir, 'nope') })).rejects.toThrow(/ENOENT/);
  });

  it('applies files in lexical order and records name + sha256', async () => {
    await write('0002_child.sql', 'create table public.child (id int primary key, parent_id int references public.parent(id));');
    await write('0001_parent.sql', 'create table public.parent (id int primary key);');
    const logged: string[] = [];
    const result = await migrate(db, { migrationsDir: dir, log: (line) => logged.push(line) });
    expect(result.applied).toEqual(['0001_parent.sql', '0002_child.sql']);
    expect(logged).toEqual(['applied local-shims.sql', 'applied 0001_parent.sql', 'applied 0002_child.sql']);
    expect(await tables()).toEqual(['child', 'parent']);
    const applied = await listAppliedMigrations(db);
    expect(applied.map((m) => [m.name, m.sha256])).toEqual([
      ['0001_parent.sql', hashSql('create table public.parent (id int primary key);')],
      ['0002_child.sql', hashSql('create table public.child (id int primary key, parent_id int references public.parent(id));')],
    ]);
    expect(applied[0]!.appliedAt).toBeInstanceOf(Date);
  });

  it('is idempotent: a re-run applies nothing', async () => {
    await write('0001_a.sql', 'create table public.a (id int);');
    await migrate(db, { migrationsDir: dir });
    const again = await migrate(db, { migrationsDir: dir });
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toEqual(['0001_a.sql']);
    expect(await tables()).toEqual(['a']);
  });

  it('applies only new files on a later run', async () => {
    await write('0001_a.sql', 'create table public.a (id int);');
    await migrate(db, { migrationsDir: dir });
    await write('0002_b.sql', 'create table public.b (id int);');
    const result = await migrate(db, { migrationsDir: dir });
    expect(result.applied).toEqual(['0002_b.sql']);
    expect(await tables()).toEqual(['a', 'b']);
  });

  it('refuses to run when an applied file changed, before applying anything', async () => {
    await write('0001_a.sql', 'create table public.a (id int);');
    await migrate(db, { migrationsDir: dir });
    await write('0001_a.sql', 'create table public.a (id int, extra text);');
    await write('0002_b.sql', 'create table public.b (id int);');
    const error = await migrate(db, { migrationsDir: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationHashMismatchError);
    expect((error as MigrationHashMismatchError).mismatches).toEqual([
      {
        name: '0001_a.sql',
        recorded: hashSql('create table public.a (id int);'),
        current: hashSql('create table public.a (id int, extra text);'),
      },
    ]);
    expect(await tables()).toEqual(['a']);
    const status = await migrationStatus(db, { migrationsDir: dir });
    expect(status.changed.map((c) => c.name)).toEqual(['0001_a.sql']);
    expect(status.pending).toEqual(['0002_b.sql']);
  });

  it('rolls back a failing file, keeps earlier ones, and names the file and line', async () => {
    await write('0001_ok.sql', 'create table public.ok (id int);');
    await write('0002_bad.sql', 'create table public.half (id int);\n\nselect * from public.missing_table;');
    await write('0003_after.sql', 'create table public.after (id int);');
    const error = await migrate(db, { migrationsDir: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationFailedError);
    expect((error as MigrationFailedError).file).toBe('0002_bad.sql');
    expect((error as MigrationFailedError).code).toBe('42P01');
    expect((error as Error).message).toMatch(/0002_bad\.sql failed at line 3: relation "public.missing_table" does not exist/);
    expect(await tables()).toEqual(['ok']);
    expect((await listAppliedMigrations(db)).map((m) => m.name)).toEqual(['0001_ok.sql']);

    await write('0002_bad.sql', 'create table public.half (id int);');
    const fixed = await migrate(db, { migrationsDir: dir });
    expect(fixed.applied).toEqual(['0002_bad.sql', '0003_after.sql']);
  });

  it('rejects files with their own transaction control', async () => {
    await write('0001_tx.sql', 'begin;\ncreate table public.t (id int);\ncommit;\n');
    await expect(migrate(db, { migrationsDir: dir })).rejects.toBeInstanceOf(MigrationTransactionControlError);
    await expect(migrate(db, { migrationsDir: dir })).rejects.toThrow(/0001_tx\.sql line 1/);
    expect(await tables()).toEqual([]);
  });

  it('applies _local_ files only on local databases', async () => {
    await write('0001_a.sql', 'create table public.a (id int);');
    await write('0002_local_seed.sql', 'create table public.local_only (id int);');

    const remote = await migrate(db, { migrationsDir: dir, local: false });
    expect(remote).toMatchObject({ local: false, shimsApplied: false, applied: ['0001_a.sql'] });
    expect(remote.skippedLocalOnly).toEqual(['0002_local_seed.sql']);
    expect(await tables()).toEqual(['a']);
    // Not local: the Supabase shims were not applied either.
    expect((await db.query("select to_regprocedure('auth.uid()') is null as missing")).rows).toEqual([{ missing: true }]);

    const local = await migrate(db, { migrationsDir: dir });
    expect(local.applied).toEqual(['0002_local_seed.sql']);
    expect(await tables()).toEqual(['a', 'local_only']);
  });

  it('applies the shims first on local databases, so migrations can use auth.*', async () => {
    await write(
      '0001_profiles.sql',
      `create table public.profiles (id uuid primary key references auth.users(id), handle text);
       alter table public.profiles enable row level security;
       create policy profiles_self on public.profiles for select to authenticated using (id = auth.uid());`,
    );
    const result = await migrate(db, { migrationsDir: dir });
    expect(result.applied).toEqual(['0001_profiles.sql']);
    const roles = await db.query<{ rolname: string; rolbypassrls: boolean }>(
      "select rolname, rolbypassrls from pg_roles where rolname in ('anon', 'authenticated', 'service_role') order by 1",
    );
    expect(roles.rows).toEqual([
      { rolname: 'anon', rolbypassrls: false },
      { rolname: 'authenticated', rolbypassrls: false },
      { rolname: 'service_role', rolbypassrls: true },
    ]);
  });

  it('can skip the shims explicitly', async () => {
    const result = await migrate(db, { migrationsDir: dir, shims: false });
    expect(result.shimsApplied).toBe(false);
    expect((await db.query("select to_regnamespace('auth') is null as missing")).rows).toEqual([{ missing: true }]);
  });

  it("shims: 'auto' (plain Postgres) applies them when auth is missing, and again over its own shims", async () => {
    expect(await needsLocalShims(db)).toBe(true);
    const first = await migrate(db, { migrationsDir: dir, local: false, shims: 'auto' });
    expect(first.shimsApplied).toBe(true);
    const marker = await db.query<{ c: string }>("select obj_description(to_regnamespace('auth')::oid, 'pg_namespace') as c");
    expect(marker.rows[0]!.c.startsWith(LOCAL_SHIM_MARKER)).toBe(true);
    // The shims can evolve: they are re-applied over their own auth schema.
    expect(await needsLocalShims(db)).toBe(true);
    expect((await migrate(db, { migrationsDir: dir, local: false, shims: 'auto' })).shimsApplied).toBe(true);
  });

  it("shims: 'auto' leaves a real (Supabase) auth schema alone", async () => {
    await db.exec("create schema auth; comment on schema auth is 'Supabase Auth';");
    expect(await needsLocalShims(db)).toBe(false);
    const result = await migrate(db, { migrationsDir: dir, local: false, shims: 'auto' });
    expect(result.shimsApplied).toBe(false);
    expect((await db.query("select to_regprocedure('auth.uid()') is null as missing")).rows).toEqual([{ missing: true }]);
  });

  it('reports recorded migrations whose file disappeared', async () => {
    await write('0001_a.sql', 'select 1;');
    await migrate(db, { migrationsDir: dir });
    await rm(join(dir, '0001_a.sql'));
    const result = await migrate(db, { migrationsDir: dir });
    expect(result.missingFiles).toEqual(['0001_a.sql']);
    expect((await migrationStatus(db, { migrationsDir: dir })).missingFiles).toEqual(['0001_a.sql']);
  });

  it('serializes concurrent runs so each file is applied once', async () => {
    await write('0001_a.sql', 'create table public.a (id int);');
    await write('0002_b.sql', 'create table public.b (id int);');
    const [one, two] = await Promise.all([migrate(db, { migrationsDir: dir }), migrate(db, { migrationsDir: dir })]);
    expect([...one.applied, ...two.applied].sort()).toEqual(['0001_a.sql', '0002_b.sql']);
    expect((await listAppliedMigrations(db)).map((m) => m.name)).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('resets a role a migration left behind', async () => {
    await write('0001_role.sql', 'set role authenticated;');
    await migrate(db, { migrationsDir: dir });
    expect((await db.query<{ u: string }>('select current_user as u')).rows[0]!.u).toBe('postgres');
  });

  it('protects the bookkeeping table from API roles', async () => {
    await write('0001_a.sql', 'select 1;');
    await migrate(db, { migrationsDir: dir });
    await expect(db.asService((tx) => tx.query('select * from y_meta.migrations'))).rejects.toThrow(/permission denied/);
    await expect(db.asUser({ sub: '0b6f3c1e-1d2a-4c5b-8e9f-0a1b2c3d4e5f' }, (tx) => tx.query('select * from y_meta.migrations'))).rejects.toThrow(/permission denied/);
  });

  it('refreshes array types so enum arrays parse after migrating', async () => {
    await write('0001_enum.sql', "create type public.mood as enum ('calm', 'busy');");
    await migrate(db, { migrationsDir: dir });
    const { rows } = await db.query<{ moods: unknown }>("select array['calm', 'busy']::public.mood[] as moods");
    expect(rows[0]!.moods).toEqual(['calm', 'busy']);
  });
});

describe('findTransactionControl', () => {
  it.each([
    ['begin;\nselect 1;', 1],
    ['select 1;\n  COMMIT ;', 2],
    ['create table x (id int);\n\nstart transaction isolation level serializable;', 3],
    ['select 1;\nrollback', 2],
    ['select 1;\n-- note\nend;', 3],
    ['/* header */\nBEGIN WORK;', 2],
  ])('finds transaction control in %j', (sql, line) => {
    expect(findTransactionControl(sql)).toBe(line);
  });

  it.each([
    'create function f() returns void language plpgsql as $$\nbegin\n  perform 1;\nend;\n$$;',
    'create function g() returns void language plpgsql as $body$ begin; commit; end $body$;',
    "select 'begin;';\nselect 'it''s; commit;';",
    "select E'it\\'s; commit;';",
    'select "begin" from t;',
    '-- begin;\n/* commit; */\nselect 1;',
    'do $$ begin raise notice $q$commit;$q$; end $$;',
    'select 1;',
  ])('ignores %j', (sql) => {
    expect(findTransactionControl(sql)).toBeUndefined();
  });
});
