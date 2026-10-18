import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbClosedError, InvalidClaimsError, NestedDbCallError, SQLSTATE, TransactionClosedError, isSqlState } from './errors.js';
import { migrate } from './migrate.js';
import { createPgliteDb, type PgliteDb } from './pglite.js';
import { notifyIn } from './sql.js';
import type { Tx } from './types.js';

const ALICE = '0b6f3c1e-1d2a-4c5b-8e9f-0a1b2c3d4e5f';
const BOB = '9e8d7c6b-5a49-4382-9172-6f5e4d3c2b1a';

/** Waits until `predicate` holds (notifications are delivered asynchronously). */
async function eventually(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30));

let db: PgliteDb;
const emptyMigrations = await mkdtemp(join(tmpdir(), 'paceline-db-empty-'));

beforeAll(async () => {
  db = await createPgliteDb();
  // Shims only: roles, auth.uid(), default grants.
  await migrate(db, { migrationsDir: emptyMigrations });
  await db.exec(`
    create table public.notes (
      id serial primary key,
      owner_id uuid not null,
      body text not null
    );
    alter table public.notes enable row level security;
    create policy notes_owner_select on public.notes for select using (owner_id = auth.uid());
    create policy notes_owner_insert on public.notes for insert with check (owner_id = auth.uid());
  `);
  await db.query('insert into public.notes (owner_id, body) values ($1, $2), ($1, $3), ($4, $5)', [
    ALICE,
    'alice 1',
    'alice 2',
    BOB,
    'bob 1',
  ]);
});

afterAll(async () => {
  await db?.close();
  await rm(emptyMigrations, { recursive: true, force: true });
});

describe('query and exec', () => {
  it('runs parameterized queries and reports row counts', async () => {
    const result = await db.query<{ n: number; t: string }>('select $1::int as n, $2::text as t', [41, 'x']);
    expect(result.rows).toEqual([{ n: 41, t: 'x' }]);
    expect(result.rowCount).toBe(1);
    const update = await db.query("update public.notes set body = body where body like 'alice%'");
    expect(update.rowCount).toBe(2);
    expect(update.rows).toEqual([]);
  });

  it('parses common types', async () => {
    const { rows } = await db.query<Record<string, unknown>>(
      "select 3::int8 as small, 9007199254740993::int8 as big, count(*) as cnt, '{\"a\":1}'::jsonb as j, '2024-01-02'::date as d, now() as ts from public.notes",
    );
    const row = rows[0]!;
    expect(row.small).toBe(3);
    expect(row.big).toBe(9007199254740993n);
    expect(row.cnt).toBe(3);
    expect(row.j).toEqual({ a: 1 });
    expect(row.d).toEqual(new Date('2024-01-02T00:00:00.000Z'));
    expect(row.ts).toBeInstanceOf(Date);
  });

  it('rejects multiple statements in query() but runs them in exec()', async () => {
    await expect(db.query('select 1; select 2')).rejects.toThrow(/multiple commands/);
    await db.exec('create temp table t_exec (x int); insert into t_exec values (1), (2); drop table t_exec;');
  });

  it('surfaces Postgres errors with their SQLSTATE', async () => {
    const error = await db.query('select * from public.does_not_exist').catch((e: unknown) => e);
    expect(isSqlState(error, SQLSTATE.undefinedTable)).toBe(true);
  });
});

describe('tx', () => {
  it('commits on success and returns the callback value', async () => {
    const value = await db.tx(async (tx) => {
      await tx.exec('create table public.tx_commit (x int)');
      await tx.query('insert into public.tx_commit values ($1)', [7]);
      return 'done';
    });
    expect(value).toBe('done');
    expect((await db.query('select x from public.tx_commit')).rows).toEqual([{ x: 7 }]);
    await db.exec('drop table public.tx_commit');
  });

  it('rolls back everything when the callback throws', async () => {
    await db.exec('create table public.tx_rollback (x int)');
    await expect(
      db.tx(async (tx) => {
        await tx.query('insert into public.tx_rollback values (1)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await db.query('select count(*)::int as n from public.tx_rollback')).rows).toEqual([{ n: 0 }]);
    await db.exec('drop table public.tx_rollback');
  });

  it('rolls back when a statement fails', async () => {
    await db.exec('create table public.tx_fail (x int primary key)');
    const error = await db
      .tx(async (tx) => {
        await tx.query('insert into public.tx_fail values (1)');
        await tx.query('insert into public.tx_fail values (1)');
      })
      .catch((e: unknown) => e);
    expect(isSqlState(error, SQLSTATE.uniqueViolation)).toBe(true);
    expect((await db.query('select count(*)::int as n from public.tx_fail')).rows).toEqual([{ n: 0 }]);
    await db.exec('drop table public.tx_fail');
  });

  it('serializes concurrent work: outside queries wait instead of joining the transaction', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inside = db.asUser({ sub: ALICE }, async (tx) => {
      await gate;
      return (await tx.query<{ u: string }>('select current_user as u')).rows[0]!.u;
    });
    const outside = db.query<{ u: string }>('select current_user as u');
    release();
    expect(await inside).toBe('authenticated');
    expect((await outside).rows[0]!.u).toBe('postgres');
  });

  it('refuses db.* calls from inside its own transaction callback', async () => {
    await expect(db.tx(async () => db.query('select 1'))).rejects.toBeInstanceOf(NestedDbCallError);
    await expect(db.asUser({ sub: ALICE }, async () => db.exec('select 1'))).rejects.toBeInstanceOf(NestedDbCallError);
    await expect(db.asService(async () => db.tx(async () => 1))).rejects.toBeInstanceOf(NestedDbCallError);
    await expect(db.tx(async () => db.notify('jobs', 'x'))).rejects.toBeInstanceOf(NestedDbCallError);
    // and the database is still usable afterwards
    expect((await db.query('select 1 as one')).rows).toEqual([{ one: 1 }]);
  });

  it('allows other databases inside a transaction', async () => {
    const other = await createPgliteDb();
    try {
      const n = await db.tx(async () => (await other.query<{ n: number }>('select 2 as n')).rows[0]!.n);
      expect(n).toBe(2);
    } finally {
      await other.close();
    }
  });

  it('invalidates the tx handle once the callback returns', async () => {
    let leaked: Tx | undefined;
    await db.tx(async (tx) => {
      leaked = tx;
    });
    await expect(leaked!.query('select 1')).rejects.toBeInstanceOf(TransactionClosedError);
    await expect(leaked!.exec('select 1')).rejects.toBeInstanceOf(TransactionClosedError);
  });

  it('does not treat work that outlives the callback as nested', async () => {
    let later: Promise<unknown> | undefined;
    await db.tx(async () => {
      later = new Promise((resolve) => setTimeout(resolve, 10)).then(() => db.query('select 1'));
    });
    await expect(later).resolves.toBeTruthy();
  });
});

describe('asUser (RLS)', () => {
  it('runs as authenticated with auth.uid() = sub and the claims visible in auth.jwt()', async () => {
    const row = await db.asUser({ sub: ALICE, agent_id: 'a_1', install_id: 'i_1', via: 'install' }, async (tx) => {
      const { rows } = await tx.query<{ uid: string; role: string; jwt: unknown; usr: string }>(
        'select auth.uid() as uid, auth.role() as role, auth.jwt() as jwt, current_user as usr',
      );
      return rows[0]!;
    });
    expect(row).toEqual({
      uid: ALICE,
      role: 'authenticated',
      usr: 'authenticated',
      jwt: { sub: ALICE, role: 'authenticated', agent_id: 'a_1', install_id: 'i_1', via: 'install' },
    });
  });

  it('filters rows by policy', async () => {
    const alice = await db.asUser({ sub: ALICE }, (tx) =>
      tx.query<{ body: string }>('select body from public.notes order by body'),
    );
    expect(alice.rows.map((r) => r.body)).toEqual(['alice 1', 'alice 2']);
    const bob = await db.asUser({ sub: BOB }, (tx) => tx.query<{ body: string }>('select body from public.notes'));
    expect(bob.rows.map((r) => r.body)).toEqual(['bob 1']);
  });

  it('enforces WITH CHECK policies on writes', async () => {
    const error = await db
      .asUser({ sub: ALICE }, (tx) =>
        tx.query('insert into public.notes (owner_id, body) values ($1, $2)', [BOB, 'forged']),
      )
      .catch((e: unknown) => e);
    expect(isSqlState(error, SQLSTATE.insufficientPrivilege)).toBe(true);
    expect(String(error)).toMatch(/row-level security/);
    await db.asUser({ sub: ALICE }, (tx) =>
      tx.query('insert into public.notes (owner_id, body) values ($1, $2)', [ALICE, 'alice 3']),
    );
    expect((await db.query("select count(*)::int as n from public.notes where body = 'forged'")).rows[0]).toEqual({ n: 0 });
    await db.query("delete from public.notes where body = 'alice 3'");
  });

  it('resets role and claims after the transaction', async () => {
    await db.asUser({ sub: ALICE }, async () => undefined);
    const { rows } = await db.query<{ usr: string; uid: string | null; claims: string | null }>(
      "select current_user as usr, auth.uid() as uid, nullif(current_setting('request.jwt.claims', true), '') as claims",
    );
    expect(rows[0]).toEqual({ usr: 'postgres', uid: null, claims: null });
  });

  it('resets role and claims after a failed transaction too', async () => {
    await expect(db.asUser({ sub: ALICE }, async () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
    expect((await db.query<{ usr: string }>('select current_user as usr')).rows[0]!.usr).toBe('postgres');
  });

  it('rejects invalid claims before touching the database', async () => {
    let ran = false;
    await expect(
      db.asUser({ sub: 'not-a-uuid' }, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(InvalidClaimsError);
    expect(ran).toBe(false);
  });
});

describe('asService', () => {
  it('bypasses RLS and reports service_role', async () => {
    const result = await db.asService(async (tx) => {
      const who = await tx.query<{ usr: string; role: string }>('select current_user as usr, auth.role() as role');
      const notes = await tx.query<{ n: number }>('select count(*)::int as n from public.notes');
      return { ...who.rows[0]!, n: notes.rows[0]!.n };
    });
    expect(result).toEqual({ usr: 'service_role', role: 'service_role', n: 3 });
  });

  it('has no auth.uid()', async () => {
    const uid = await db.asService(async (tx) => (await tx.query<{ uid: string | null }>('select auth.uid() as uid')).rows[0]!.uid);
    expect(uid).toBeNull();
  });
});

describe('asAnon', () => {
  it('runs as anon: RLS applies, no uid, role anon', async () => {
    const result = await db.asAnon(async (tx) => {
      const who = await tx.query<{ usr: string; role: string; uid: string | null }>(
        'select current_user as usr, auth.role() as role, auth.uid() as uid',
      );
      const notes = await tx.query<{ n: number }>('select count(*)::int as n from public.notes');
      return { ...who.rows[0]!, n: notes.rows[0]!.n };
    });
    expect(result).toEqual({ usr: 'anon', role: 'anon', uid: null, n: 0 });
  });
});

describe('listen / notify', () => {
  it('delivers notifications to every listener on the channel', async () => {
    const a: string[] = [];
    const b: string[] = [];
    const unA = await db.listen('test_events', (p) => {
      a.push(p);
    });
    const unB = await db.listen('test_events', (p) => {
      b.push(p);
    });
    await db.notify('test_events', 'one');
    await eventually(() => a.length === 1 && b.length === 1);
    expect(a).toEqual(['one']);
    expect(b).toEqual(['one']);
    await unA();
    await db.notify('test_events', 'two');
    await eventually(() => b.length === 2);
    await settle();
    expect(a).toEqual(['one']);
    expect(b).toEqual(['one', 'two']);
    await unB();
    await unB(); // idempotent
    await db.notify('test_events', 'three');
    await settle();
    expect(b).toEqual(['one', 'two']);
  });

  it('delivers transactional notifications on commit only', async () => {
    const got: string[] = [];
    const unlisten = await db.listen('test_tx', (p) => {
      got.push(p);
    });
    await db.tx((tx) => notifyIn(tx, 'test_tx', 'committed'));
    await expect(
      db.tx(async (tx) => {
        await notifyIn(tx, 'test_tx', 'rolled back');
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    await eventually(() => got.length >= 1);
    await settle();
    expect(got).toEqual(['committed']);
    await unlisten();
  });

  it('runs handlers outside the transaction scope, so they can use db', async () => {
    const seen: number[] = [];
    const unlisten = await db.listen('test_scope', async () => {
      const { rows } = await db.query<{ n: number }>('select 5 as n');
      seen.push(rows[0]!.n);
    });
    await db.tx((tx) => notifyIn(tx, 'test_scope', 'x'));
    await eventually(() => seen.length === 1);
    expect(seen).toEqual([5]);
    await unlisten();
  });

  it('reports handler errors instead of throwing them', async () => {
    const reported: Array<[unknown, string]> = [];
    const local = await createPgliteDb({ onError: (error, context) => reported.push([error, context]) });
    try {
      await local.listen('test_errors', () => {
        throw new Error('sync handler failure');
      });
      await local.listen('test_errors', async () => {
        throw new Error('async handler failure');
      });
      await local.notify('test_errors', 'x');
      await eventually(() => reported.length === 2);
      expect(reported.map(([e]) => (e as Error).message).sort()).toEqual(['async handler failure', 'sync handler failure']);
      expect(reported[0]![1]).toContain('test_errors');
    } finally {
      await local.close();
    }
  });

  it('validates channel names and payloads', async () => {
    await expect(db.listen('Bad Channel', () => undefined)).rejects.toThrow(/invalid channel/);
    await expect(db.listen('x; drop table notes', () => undefined)).rejects.toThrow(/invalid channel/);
    await expect(db.notify('BAD', 'x')).rejects.toThrow(/invalid channel/);
    await expect(db.notify('ok_channel', 'x'.repeat(9000))).rejects.toThrow(/payload/);
  });
});

describe('lifecycle', () => {
  it('persists to a data directory and reopens it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'paceline-db-data-'));
    try {
      const first = await createPgliteDb({ dataDir: join(dir, 'nested', 'pgdata') });
      await first.exec("create table kept (v text); insert into kept values ('hello');");
      await first.close();
      const second = await createPgliteDb({ dataDir: join(dir, 'nested', 'pgdata') });
      expect((await second.query('select v from kept')).rows).toEqual([{ v: 'hello' }]);
      expect(second.dataDir).toBe(join(dir, 'nested', 'pgdata'));
      await second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the Supabase search_path', async () => {
    expect((await db.query<{ search_path: string }>('show search_path')).rows[0]!.search_path).toBe(
      '"$user", public, extensions',
    );
  });

  it('refuses use after close, and close is idempotent', async () => {
    const temp = await createPgliteDb();
    expect(temp.kind).toBe('pglite');
    expect(temp.local).toBe(true);
    await temp.close();
    await temp.close();
    await expect(temp.query('select 1')).rejects.toBeInstanceOf(DbClosedError);
    await expect(temp.tx(async () => 1)).rejects.toBeInstanceOf(DbClosedError);
  });

  it('rejects loadDataDir with a file data directory', async () => {
    await expect(createPgliteDb({ dataDir: '/tmp/x', loadDataDir: new Blob([]) })).rejects.toThrow(/in-memory/);
  });
});
