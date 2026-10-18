/**
 * pg adapter against a real Postgres. Skipped unless DATABASE_URL is set,
 * e.g. `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm --filter @y/db test`.
 *
 * Non-destructive: everything happens in temp tables or rolled-back
 * transactions. asUser/asService checks need the Supabase roles (Supabase,
 * `supabase start`, or a local Postgres migrated with --local).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestedDbCallError } from './errors.js';
import { createPgDb, type PgDb } from './pg.js';
import { notifyIn } from './sql.js';

const url = process.env.DATABASE_URL?.trim();
const USER = '7f0c8a52-6a40-4b8a-9d3f-1f4a2b3c4d5e';

describe.skipIf(!url)('pg adapter (integration, DATABASE_URL)', () => {
  let db: PgDb;
  let hasSupabaseRoles = false;

  beforeAll(async () => {
    db = createPgDb({ connectionString: url!, listenHeartbeatMs: 0 });
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_roles where rolname in ('authenticated', 'service_role')",
    );
    const auth = await db.query<{ ok: boolean }>("select to_regprocedure('auth.uid()') is not null as ok");
    hasSupabaseRoles = rows[0]!.n === 2 && auth.rows[0]!.ok;
  });

  afterAll(async () => {
    await db?.close();
  });

  it('runs parameterized queries with PGlite-compatible types', async () => {
    const { rows } = await db.query<Record<string, unknown>>(
      "select $1::int as n, count(*) as c, 9007199254740993::int8 as big, '2024-01-02'::date as d from (values (1), (2)) v(x)",
      [7],
    );
    expect(rows[0]).toEqual({ n: 7, c: 2, big: 9007199254740993n, d: new Date('2024-01-02T00:00:00.000Z') });
  });

  it('rejects multi-statement query() like PGlite', async () => {
    await expect(db.query('select 1; select 2')).rejects.toThrow(/multiple commands/);
  });

  it('rolls back transactions', async () => {
    const result = await db
      .tx(async (tx) => {
        await tx.exec('create temp table y_it_rollback (x int) on commit drop');
        await tx.query('insert into y_it_rollback values (1)');
        throw new Error('rollback please');
      })
      .catch((e: unknown) => e);
    expect((result as Error).message).toBe('rollback please');
    const exists = await db.query<{ ok: boolean }>("select to_regclass('pg_temp.y_it_rollback') is null as ok");
    expect(exists.rows[0]!.ok).toBe(true);
  });

  it('guards against nested db use', async () => {
    await expect(db.tx(async () => db.query('select 1'))).rejects.toBeInstanceOf(NestedDbCallError);
  });

  it('asUser sets role and auth.uid()', async (context) => {
    if (!hasSupabaseRoles) context.skip();
    const row = await db.asUser({ sub: USER, via: 'web' }, async (tx) => {
      return (await tx.query<{ uid: string; usr: string }>('select auth.uid() as uid, current_user as usr')).rows[0];
    });
    expect(row).toEqual({ uid: USER, usr: 'authenticated' });
  });

  it('asService runs as service_role', async (context) => {
    if (!hasSupabaseRoles) context.skip();
    const usr = await db.asService(async (tx) => (await tx.query<{ usr: string }>('select current_user as usr')).rows[0]!.usr);
    expect(usr).toBe('service_role');
  });

  it('asAnon runs as anon', async (context) => {
    if (!hasSupabaseRoles) context.skip();
    const row = await db.asAnon(async (tx) => (await tx.query<{ usr: string; uid: string | null }>('select current_user as usr, auth.uid() as uid')).rows[0]);
    expect(row).toEqual({ usr: 'anon', uid: null });
  });

  it('delivers LISTEN/NOTIFY, including transactional notifies on commit', async () => {
    const got: string[] = [];
    const channel = `y_it_${process.pid}`;
    const unlisten = await db.listen(channel, (payload) => {
      got.push(payload);
    });
    await db.notify(channel, 'direct');
    await db.tx((tx) => notifyIn(tx, channel, 'committed'));
    await db.tx(async (tx) => {
      await notifyIn(tx, channel, 'rolled back');
      throw new Error('no');
    }).catch(() => undefined);
    const deadline = Date.now() + 5000;
    while (got.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual(['direct', 'committed']);
    await unlisten();
  });
});
