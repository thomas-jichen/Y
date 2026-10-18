/**
 * The local Supabase shims (local-shims.sql): roles, auth.* helpers, default
 * grants. These stand in for Supabase on PGlite, so they must behave like it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_SHIM_MARKER, applyLocalShims, migrate, readLocalShims } from './migrate.js';
import { createPgliteDb, type PgliteDb } from './pglite.js';

const USER = '5d1f6c0a-2b3c-4d5e-8f90-a1b2c3d4e5f6';
let db: PgliteDb;
let empty: string;

beforeAll(async () => {
  empty = await mkdtemp(join(tmpdir(), 'paceline-shims-'));
  db = await createPgliteDb();
  await migrate(db, { migrationsDir: empty });
});

afterAll(async () => {
  await db?.close();
  await rm(empty, { recursive: true, force: true });
});

describe('local shims', () => {
  it('are idempotent', async () => {
    await applyLocalShims(db);
    await applyLocalShims(db);
    expect((await db.query<{ n: number }>("select count(*)::int as n from pg_roles where rolname = 'service_role'")).rows[0]!.n).toBe(1);
  });

  it('never use create-or-replace on roles or drop anything', async () => {
    const sql = await readLocalShims();
    expect(sql).not.toMatch(/\bdrop\s+(table|schema|role|function)\b/i);
    expect(sql).toMatch(/if not exists/i);
  });

  it('create the API roles as NOLOGIN with service_role bypassing RLS', async () => {
    const { rows } = await db.query<{ rolname: string; rolcanlogin: boolean; rolbypassrls: boolean; rolsuper: boolean }>(
      "select rolname, rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname in ('anon', 'authenticated', 'service_role') order by 1",
    );
    expect(rows).toEqual([
      { rolname: 'anon', rolcanlogin: false, rolbypassrls: false, rolsuper: false },
      { rolname: 'authenticated', rolcanlogin: false, rolbypassrls: false, rolsuper: false },
      { rolname: 'service_role', rolcanlogin: false, rolbypassrls: true, rolsuper: false },
    ]);
  });

  it('auth.uid/role/email/jwt read request.jwt.claims', async () => {
    const row = await db.tx(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: USER, role: 'authenticated', email: 'dev@example.test', agent_id: 'a_1' }),
      ]);
      return (await tx.query('select auth.uid() as uid, auth.role() as role, auth.email() as email, auth.jwt() as jwt')).rows[0];
    });
    expect(row).toEqual({
      uid: USER,
      role: 'authenticated',
      email: 'dev@example.test',
      jwt: { sub: USER, role: 'authenticated', email: 'dev@example.test', agent_id: 'a_1' },
    });
  });

  it('auth.* return null without claims, including the empty value a finished transaction leaves behind', async () => {
    const none = { uid: null, role: null, email: null, jwt: null };
    const sql = 'select auth.uid() as uid, auth.role() as role, auth.email() as email, auth.jwt() as jwt';
    expect((await db.query(sql)).rows[0]).toEqual(none);
    await db.tx((tx) => tx.query("select set_config('request.jwt.claims', '{\"sub\":\"" + USER + "\"}', true)"));
    expect((await db.query<{ c: string }>("select current_setting('request.jwt.claims', true) as c")).rows[0]!.c).toBe('');
    expect((await db.query(sql)).rows[0]).toEqual(none);
  });

  it('honor the legacy request.jwt.claim.sub setting', async () => {
    const uid = await db.tx(async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [USER]);
      return (await tx.query<{ uid: string }>('select auth.uid() as uid')).rows[0]!.uid;
    });
    expect(uid).toBe(USER);
  });

  it('grant API roles access to new public tables by default (as Supabase does)', async () => {
    await db.exec('create table public.shim_grants (id int); create sequence public.shim_seq;');
    const { rows } = await db.query<{ grantee: string; n: number }>(
      `select grantee, count(*)::int as n from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'shim_grants' and grantee in ('anon', 'authenticated', 'service_role')
       group by grantee order by grantee`,
    );
    expect(rows.map((r) => r.grantee)).toEqual(['anon', 'authenticated', 'service_role']);
    const seq = await db.asUser({ sub: USER }, (tx) => tx.query<{ v: number }>("select nextval('public.shim_seq')::int as v"));
    expect(seq.rows[0]!.v).toBe(1);
    await db.exec('drop table public.shim_grants; drop sequence public.shim_seq;');
  });

  it('keep auth.users away from the API roles', async () => {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [USER, 'u@example.test']);
    await expect(db.asUser({ sub: USER }, (tx) => tx.query('select * from auth.users'))).rejects.toThrow(/permission denied/);
    await expect(db.asService((tx) => tx.query('select * from auth.users'))).rejects.toThrow(/permission denied/);
    const { rows } = await db.query<{ email: string; raw_user_meta_data: unknown; aud: string }>(
      'select email, raw_user_meta_data, aud from auth.users where id = $1',
      [USER],
    );
    expect(rows).toEqual([{ email: 'u@example.test', raw_user_meta_data: {}, aud: 'authenticated' }]);
  });

  it('enable pgcrypto and uuid-ossp in schema extensions, resolvable through search_path', async () => {
    const { rows } = await db.query<{ extname: string; schema: string }>(
      "select e.extname, n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname in ('pgcrypto', 'uuid-ossp') order by 1",
    );
    expect(rows).toEqual([
      { extname: 'pgcrypto', schema: 'extensions' },
      { extname: 'uuid-ossp', schema: 'extensions' },
    ]);
    const hashed = await db.query<{ h: string; u: string }>(
      "select encode(digest('abc', 'sha256'), 'hex') as h, uuid_generate_v4()::text as u",
    );
    expect(hashed.rows[0]!.h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashed.rows[0]!.u).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mark the schemas they create, so plain Postgres can tell them from Supabase', async () => {
    const { rows } = await db.query<{ nspname: string; c: string }>(
      "select nspname, obj_description(oid, 'pg_namespace') as c from pg_namespace where nspname in ('auth', 'realtime') order by 1",
    );
    expect(rows.map((r) => r.nspname)).toEqual(['auth', 'realtime']);
    for (const row of rows) expect(row.c.startsWith(LOCAL_SHIM_MARKER)).toBe(true);
  });

  it('provide realtime.send(payload, event, topic, private) as NOTIFY paceline_realtime', async () => {
    const got: unknown[] = [];
    const unlisten = await db.listen('paceline_realtime', (payload) => {
      got.push(JSON.parse(payload));
    });
    try {
      await db.query("select realtime.send($1::jsonb, 'review.new', $2, false)", [
        JSON.stringify({ id: '7', type: 'review.new', payload: { reviewId: 'rv_00000000000000000000RVW001' } }),
        `user:${USER}:${'a'.repeat(64)}`,
      ]);
      await expect.poll(() => got.length).toBe(1);
      expect(got[0]).toEqual({
        topic: `user:${USER}:${'a'.repeat(64)}`,
        event: 'review.new',
        payload: { id: '7', type: 'review.new', payload: { reviewId: 'rv_00000000000000000000RVW001' } },
        private: false,
      });
    } finally {
      await unlisten();
    }
  });

  it('keep realtime.send away from the API roles (only definer code broadcasts)', async () => {
    await expect(
      db.asUser({ sub: USER }, (tx) => tx.query("select realtime.send('{}'::jsonb, 'x', 'user:x:y', false)")),
    ).rejects.toThrow(/permission denied/);
  });

  it('leave a real realtime schema alone', async () => {
    const other = await createPgliteDb();
    try {
      await other.exec(`
        create schema realtime;
        create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
        returns void language sql as 'select null';
      `);
      await applyLocalShims(other);
      const { rows } = await other.query<{ src: string }>(
        "select prosrc as src from pg_proc where oid = 'realtime.send(jsonb, text, text, boolean)'::regprocedure",
      );
      expect(rows[0]!.src).toBe('select null');
    } finally {
      await other.close();
    }
  });

  it('make the extensions PGlite ships available to migrations', async () => {
    await db.exec(`
      create extension if not exists vector with schema extensions;
      create extension if not exists pg_trgm with schema extensions;
      create extension if not exists citext with schema extensions;
      create table public.shim_ext (handle citext, embedding vector(3));
      create index on public.shim_ext using hnsw (embedding vector_cosine_ops);
    `);
    await db.query('insert into public.shim_ext values ($1, $2), ($3, $4)', ['Vivan', '[1,0,0]', 'maya', '[0,1,0]']);
    const nearest = await db.query<{ handle: string }>(
      "select handle from public.shim_ext order by embedding <=> '[0.9,0.1,0]' limit 1",
    );
    expect(nearest.rows).toEqual([{ handle: 'Vivan' }]);
    const ci = await db.query<{ n: number }>("select count(*)::int as n from public.shim_ext where handle = 'VIVAN'");
    expect(ci.rows[0]!.n).toBe(1);
    const sim = await db.query<{ s: number }>("select similarity('quarry migrate', 'quarry migration') as s");
    expect(sim.rows[0]!.s).toBeGreaterThan(0.5);
    await db.exec('drop table public.shim_ext');
  });
});
