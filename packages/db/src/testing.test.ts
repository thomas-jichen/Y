import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAppliedMigrations } from './migrate.js';
import {
  claimsFor,
  createAuthUser,
  createTestDb,
  resetTestDbTemplates,
  testDbTemplate,
  withAnon,
  withService,
  withTestDb,
  withUser,
} from './testing.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'paceline-testing-'));
  await writeFile(
    join(dir, '0001_profiles.sql'),
    `create table public.profiles (
       id uuid primary key references auth.users(id) on delete cascade,
       handle text not null
     );
     alter table public.profiles enable row level security;
     create policy profiles_self on public.profiles for all to authenticated
       using (id = auth.uid()) with check (id = auth.uid());

     create function public.handle_new_user() returns trigger
     language plpgsql security definer set search_path = public as $$
     begin
       insert into public.profiles (id, handle)
       values (new.id, coalesce(new.raw_user_meta_data ->> 'user_name', 'anon'));
       return new;
     end;
     $$;
     create trigger on_auth_user_created after insert on auth.users
       for each row execute function public.handle_new_user();`,
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createTestDb', () => {
  it('returns migrated, isolated databases', async () => {
    const a = await createTestDb({ migrationsDir: dir });
    const b = await createTestDb({ migrationsDir: dir });
    try {
      expect((await listAppliedMigrations(a)).map((m) => m.name)).toEqual(['0001_profiles.sql']);
      await createAuthUser(a, { userMetadata: { user_name: 'octocat' } });
      expect((await a.query('select handle from public.profiles')).rows).toEqual([{ handle: 'octocat' }]);
      expect((await b.query('select handle from public.profiles')).rows).toEqual([]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('builds the template once per options and clones it', async () => {
    const first = testDbTemplate({ migrationsDir: dir });
    expect(testDbTemplate({ migrationsDir: dir })).toBe(first);
    expect(testDbTemplate({ migrationsDir: dir, pgtap: true })).not.toBe(first);
    const started = performance.now();
    await withTestDb(async (db) => {
      expect((await db.query('select 1 as one')).rows).toEqual([{ one: 1 }]);
    }, { migrationsDir: dir });
    // Cloning is far cheaper than migrating; keep a generous bound for slow CI.
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('installs pgTAP on request', async () => {
    await withTestDb(
      async (db) => {
        const { rows } = await db.query<{ plan: string }>('select plan(1) as plan');
        expect(rows[0]!.plan).toBe('1..1');
      },
      { migrationsDir: dir, pgtap: true },
    );
  });

  it('does not cache failed templates', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'paceline-testing-broken-'));
    try {
      await writeFile(join(broken, '0001_bad.sql'), 'select * from nowhere;');
      await expect(createTestDb({ migrationsDir: broken })).rejects.toThrow(/0001_bad\.sql failed/);
      await writeFile(join(broken, '0001_bad.sql'), 'select 1;');
      await withTestDb(async (db) => {
        expect((await listAppliedMigrations(db)).map((m) => m.name)).toEqual(['0001_bad.sql']);
      }, { migrationsDir: broken });
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  it('resetTestDbTemplates forces a rebuild', () => {
    const before = testDbTemplate({ migrationsDir: dir });
    resetTestDbTemplates();
    expect(testDbTemplate({ migrationsDir: dir })).not.toBe(before);
  });
});

describe('user helpers', () => {
  it('withUser scopes queries to the user; withService sees everything', async () => {
    await withTestDb(
      async (db) => {
        const alice = await createAuthUser(db, { userMetadata: { user_name: 'alice' } });
        const bob = await createAuthUser(db, { email: null, userMetadata: { user_name: 'bob' } });
        const mine = await withUser(db, alice, (tx) => tx.query<{ handle: string }>('select handle from public.profiles'));
        expect(mine.rows).toEqual([{ handle: 'alice' }]);
        const viaClaims = await withUser(db, claimsFor(bob, { via: 'web' }), async (tx) => {
          return (await tx.query<{ via: string }>("select auth.jwt() ->> 'via' as via")).rows[0]!.via;
        });
        expect(viaClaims).toBe('web');
        const all = await withService(db, (tx) => tx.query('select handle from public.profiles order by handle'));
        expect(all.rows).toEqual([{ handle: 'alice' }, { handle: 'bob' }]);
        const anon = await withAnon(db, (tx) => tx.query('select handle from public.profiles'));
        expect(anon.rows).toEqual([]);
      },
      { migrationsDir: dir },
    );
  });

  it('createAuthUser honors explicit ids and metadata', async () => {
    await withTestDb(
      async (db) => {
        const id = await createAuthUser(db, {
          id: '11111111-2222-4333-8444-555555555555',
          email: 'dev@example.test',
          appMetadata: { provider: 'github' },
        });
        expect(id).toBe('11111111-2222-4333-8444-555555555555');
        const { rows } = await db.query('select email, raw_app_meta_data from auth.users where id = $1', [id]);
        expect(rows).toEqual([{ email: 'dev@example.test', raw_app_meta_data: { provider: 'github' } }]);
      },
      { migrationsDir: dir },
    );
  });

  it('claimsFor builds asUser claims', () => {
    expect(claimsFor('u', { agent_id: 'a', install_id: 'i', via: 'install' })).toEqual({
      sub: 'u',
      agent_id: 'a',
      install_id: 'i',
      via: 'install',
    });
  });
});
