/**
 * Unit tests for the pg adapter against in-memory fakes of pg.Pool / pg.Client:
 * the exact SQL and protocol each operation uses, connection handling, and
 * LISTEN reconnects. No server needed (see pg.integration.test.ts for that).
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createDb } from './create.js';
import { DbClosedError, InvalidClaimsError, NestedDbCallError, TransactionClosedError } from './errors.js';
import {
  ARRAY_TYPES_SQL,
  PgTypeParsers,
  createPgDb,
  extendedQuery,
  parseDate,
  parseInt8,
  type PgListenClientLike,
  type PgNotificationLike,
  type PgPoolClientLike,
  type PgPoolLike,
  type PgQueryConfig,
  type PgResultLike,
} from './pg.js';
import { SET_CLAIMS_SQL } from './sql.js';
import type { Tx } from './types.js';

const USER = '7f0c8a52-6a40-4b8a-9d3f-1f4a2b3c4d5e';

type Sent = PgQueryConfig | string;
const textOf = (sent: Sent): string => (typeof sent === 'string' ? sent : sent.text);

class FakeClient implements PgPoolClientLike {
  readonly sent: Sent[] = [];
  readonly released: Array<Error | boolean | undefined> = [];
  constructor(private readonly fail: (text: string) => Error | undefined) {}
  async query(config: Sent): Promise<PgResultLike> {
    this.sent.push(config);
    const error = this.fail(textOf(config));
    if (error) throw error;
    return { rows: [{ ok: true }], rowCount: 1 };
  }
  release(destroy?: Error | boolean): void {
    this.released.push(destroy);
  }
}

class FakePool implements PgPoolLike {
  readonly sent: Sent[] = [];
  readonly clients: FakeClient[] = [];
  readonly errorListeners: Array<(error: Error) => void> = [];
  ended = 0;
  fail: (text: string) => Error | undefined = () => undefined;
  rows: unknown[] = [{ ok: true }];
  async query(config: Sent): Promise<PgResultLike> {
    this.sent.push(config);
    const error = this.fail(textOf(config));
    if (error) throw error;
    return { rows: this.rows, rowCount: this.rows.length };
  }
  async connect(): Promise<FakeClient> {
    const client = new FakeClient((text) => this.fail(text));
    this.clients.push(client);
    return client;
  }
  async end(): Promise<void> {
    this.ended++;
  }
  on(_event: 'error', listener: (error: Error) => void): this {
    this.errorListeners.push(listener);
    return this;
  }
}

class FakeListenClient extends EventEmitter implements PgListenClientLike {
  readonly sent: string[] = [];
  connected = false;
  ended = false;
  constructor(
    private readonly connectError?: Error,
    private readonly queryFail: (text: string) => Error | undefined = () => undefined,
  ) {
    super();
  }
  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }
  async query(sql: string): Promise<unknown> {
    this.sent.push(sql);
    const error = this.queryFail(sql);
    if (error) throw error;
    return {};
  }
  async end(): Promise<void> {
    this.ended = true;
  }
  notify(channel: string, payload: string): void {
    const message: PgNotificationLike = { channel, payload };
    this.emit('notification', message);
  }
}

function setup(
  options: {
    listenClients?: Array<() => FakeListenClient>;
    heartbeatMs?: number;
  } = {},
) {
  const pool = new FakePool();
  const listenClients: FakeListenClient[] = [];
  const factories = options.listenClients ?? [];
  const reported: Array<[unknown, string]> = [];
  const db = createPgDb({
    connectionString: 'postgres://fake',
    pool,
    createListenClient: () => {
      const make = factories[listenClients.length] ?? (() => new FakeListenClient());
      const client = make();
      listenClients.push(client);
      return client;
    },
    reconnect: { initialDelayMs: 1, maxDelayMs: 4 },
    listenHeartbeatMs: options.heartbeatMs ?? 0,
    onError: (error, context) => reported.push([error, context]),
  });
  return { db, pool, listenClients, reported };
}

async function eventually(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const ext = (text: string, values: unknown[] = []): PgQueryConfig => ({ text, values, queryMode: 'extended' });

describe('query building', () => {
  it('always uses the extended protocol for query()', () => {
    expect(extendedQuery('select 1')).toEqual(ext('select 1'));
    const params = [1, 'a'] as const;
    const config = extendedQuery('select $1, $2', params);
    expect(config).toEqual(ext('select $1, $2', [1, 'a']));
    expect(config.values).not.toBe(params);
  });

  it('db.query sends extended configs; db.exec sends plain text (simple protocol)', async () => {
    const { db, pool } = setup();
    const result = await db.query('select $1::int as n', [5]);
    expect(result).toEqual({ rows: [{ ok: true }], rowCount: 1 });
    await db.exec('create table a (x int); create table b (y int);');
    expect(pool.sent).toEqual([ext('select $1::int as n', [5]), 'create table a (x int); create table b (y int);']);
    expect(pool.clients).toHaveLength(0);
  });

  it('notify uses pg_notify with bound channel and payload', async () => {
    const { db, pool } = setup();
    await db.notify('paceline_events', '{"id":1}');
    expect(pool.sent).toEqual([ext('select pg_notify($1, $2)', ['paceline_events', '{"id":1}'])]);
    await expect(db.notify('Bad', 'x')).rejects.toThrow(/invalid channel/);
  });
});

describe('transactions', () => {
  it('tx: BEGIN, statements, COMMIT on one client, then release', async () => {
    const { db, pool } = setup();
    const value = await db.tx(async (tx) => {
      await tx.query('insert into t values ($1)', [1]);
      await tx.exec('select 1; select 2;');
      return 42;
    });
    expect(value).toBe(42);
    expect(pool.clients).toHaveLength(1);
    const [client] = pool.clients;
    expect(client!.sent).toEqual(['BEGIN', ext('insert into t values ($1)', [1]), 'select 1; select 2;', 'COMMIT']);
    expect(client!.released).toEqual([undefined]);
    expect(pool.sent).toEqual([]);
  });

  it('asUser: sets role and transaction-local claims right after BEGIN', async () => {
    const { db, pool } = setup();
    await db.asUser({ sub: USER, agent_id: 'a_1', via: 'install' }, (tx) => tx.query('select * from activities'));
    expect(pool.clients[0]!.sent).toEqual([
      'BEGIN',
      ext('set local role authenticated'),
      ext(SET_CLAIMS_SQL, [`{"sub":"${USER}","role":"authenticated","agent_id":"a_1","via":"install"}`]),
      ext('select * from activities'),
      'COMMIT',
    ]);
  });

  it('asService: sets service_role and service claims', async () => {
    const { db, pool } = setup();
    await db.asService((tx) => tx.query('select 1'));
    expect(pool.clients[0]!.sent).toEqual([
      'BEGIN',
      ext('set local role service_role'),
      ext(SET_CLAIMS_SQL, ['{"role":"service_role"}']),
      ext('select 1'),
      'COMMIT',
    ]);
  });

  it('asAnon: sets anon and anon claims', async () => {
    const { db, pool } = setup();
    await db.asAnon((tx) => tx.query('select 1'));
    expect(pool.clients[0]!.sent).toEqual([
      'BEGIN',
      ext('set local role anon'),
      ext(SET_CLAIMS_SQL, ['{"role":"anon"}']),
      ext('select 1'),
      'COMMIT',
    ]);
  });

  it('rolls back and rethrows the original error when the callback throws', async () => {
    const { db, pool } = setup();
    const boom = new Error('boom');
    await expect(
      db.tx(async (tx) => {
        await tx.query('select 1');
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(pool.clients[0]!.sent.map(textOf)).toEqual(['BEGIN', 'select 1', 'ROLLBACK']);
    expect(pool.clients[0]!.released).toEqual([undefined]);
  });

  it('rolls back when the prelude fails (e.g. a missing role)', async () => {
    const { db, pool } = setup();
    pool.fail = (text) => (text === 'set local role authenticated' ? new Error('role "authenticated" does not exist') : undefined);
    await expect(db.asUser({ sub: USER }, async () => 1)).rejects.toThrow(/does not exist/);
    expect(pool.clients[0]!.sent.map(textOf)).toEqual(['BEGIN', 'set local role authenticated', 'ROLLBACK']);
  });

  it('rolls back when COMMIT fails', async () => {
    const { db, pool } = setup();
    pool.fail = (text) => (text === 'COMMIT' ? new Error('could not serialize access') : undefined);
    await expect(db.tx(async () => 1)).rejects.toThrow(/serialize/);
    expect(pool.clients[0]!.sent).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
  });

  it('destroys the connection when ROLLBACK itself fails', async () => {
    const { db, pool } = setup();
    const dead = new Error('connection terminated');
    pool.fail = (text) => (text === 'ROLLBACK' ? dead : undefined);
    await expect(db.tx(async () => Promise.reject(new Error('first')))).rejects.toThrow('first');
    expect(pool.clients[0]!.released).toEqual([dead]);
  });

  it('destroys the connection when BEGIN fails, without trying ROLLBACK', async () => {
    const { db, pool } = setup();
    const dead = new Error('connection reset');
    pool.fail = (text) => (text === 'BEGIN' ? dead : undefined);
    await expect(db.tx(async () => 1)).rejects.toBe(dead);
    expect(pool.clients[0]!.sent).toEqual(['BEGIN']);
    expect(pool.clients[0]!.released).toEqual([dead]);
  });

  it('validates claims before checking out a connection', async () => {
    const { db, pool } = setup();
    await expect(db.asUser({ sub: 'nope' }, async () => 1)).rejects.toBeInstanceOf(InvalidClaimsError);
    expect(pool.clients).toHaveLength(0);
  });

  it('refuses db.* inside its own transaction (would escape the transaction and RLS)', async () => {
    const { db, pool } = setup();
    await expect(db.asUser({ sub: USER }, async () => db.query('select * from secrets'))).rejects.toBeInstanceOf(
      NestedDbCallError,
    );
    expect(pool.sent).toEqual([]);
    expect(pool.clients[0]!.sent.map(textOf).at(-1)).toBe('ROLLBACK');
  });

  it('invalidates the tx handle after the callback (the connection is back in the pool)', async () => {
    const { db } = setup();
    let leaked: Tx | undefined;
    await db.tx(async (tx) => {
      leaked = tx;
    });
    await expect(leaked!.query('select 1')).rejects.toBeInstanceOf(TransactionClosedError);
  });
});

describe('listen', () => {
  it('uses one dedicated client: LISTEN per channel, dispatch, UNLISTEN when the last handler leaves', async () => {
    const { db, listenClients } = setup();
    const a: string[] = [];
    const b: string[] = [];
    const unA = await db.listen('events', (p) => {
      a.push(p);
    });
    const unB = await db.listen('events', (p) => {
      b.push(p);
    });
    const unJobs = await db.listen('jobs', () => undefined);
    expect(listenClients).toHaveLength(1);
    const client = listenClients[0]!;
    expect(client.connected).toBe(true);
    expect(client.sent).toEqual(['LISTEN "events"', 'LISTEN "jobs"']);

    client.notify('events', 'hello');
    client.notify('other', 'ignored');
    await eventually(() => a.length === 1 && b.length === 1);
    expect([a, b]).toEqual([['hello'], ['hello']]);

    await unA();
    expect(client.sent).not.toContain('UNLISTEN "events"');
    await unB();
    await unB();
    expect(client.sent.filter((s) => s === 'UNLISTEN "events"')).toHaveLength(1);
    await unJobs();
    expect(client.sent).toContain('UNLISTEN "jobs"');
  });

  it('reconnects with backoff after the connection drops, re-LISTENs, and calls onReconnect', async () => {
    const { db, listenClients, reported } = setup({
      listenClients: [
        () => new FakeListenClient(),
        () => new FakeListenClient(new Error('ECONNREFUSED')),
        () => new FakeListenClient(new Error('ECONNREFUSED')),
        () => new FakeListenClient(),
      ],
    });
    const got: string[] = [];
    let reconnects = 0;
    await db.listen(
      'events',
      (p) => {
        got.push(p);
      },
      { onReconnect: () => reconnects++ },
    );
    await db.listen('jobs', () => undefined);
    listenClients[0]!.emit('error', new Error('server closed the connection'));

    await eventually(() => listenClients.length === 4 && listenClients[3]!.connected && reconnects === 1);
    const fresh = listenClients[3]!;
    expect(fresh.sent).toEqual(['LISTEN "events"', 'LISTEN "jobs"']);
    expect(listenClients[0]!.ended).toBe(true);
    expect(reported.map(([, context]) => context)).toEqual([
      'LISTEN connection lost',
      'LISTEN reconnect failed',
      'LISTEN reconnect failed',
    ]);

    fresh.notify('events', 'after reconnect');
    listenClients[0]!.notify('events', 'stale client');
    await eventually(() => got.length === 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(['after reconnect']);
    await db.close();
  });

  it('treats a clean end of the connection like an error', async () => {
    const { db, listenClients } = setup();
    await db.listen('events', () => undefined);
    listenClients[0]!.emit('end');
    await eventually(() => listenClients.length === 2 && listenClients[1]!.connected);
    expect(listenClients[1]!.sent).toEqual(['LISTEN "events"']);
    await db.close();
  });

  it('detects a dead connection with the heartbeat', async () => {
    let beats = 0;
    const { db, listenClients } = setup({
      heartbeatMs: 5,
      listenClients: [
        () => new FakeListenClient(undefined, (sql) => (sql === 'select 1' && ++beats >= 2 ? new Error('timeout') : undefined)),
        () => new FakeListenClient(),
      ],
    });
    await db.listen('events', () => undefined);
    await eventually(() => listenClients.length === 2 && listenClients[1]!.connected);
    expect(listenClients[1]!.sent[0]).toBe('LISTEN "events"');
    await db.close();
  });

  it('propagates a failed first connection to the caller and forgets the channel', async () => {
    const { db, listenClients } = setup({
      listenClients: [() => new FakeListenClient(new Error('ECONNREFUSED')), () => new FakeListenClient()],
    });
    await expect(db.listen('events', () => undefined)).rejects.toThrow('ECONNREFUSED');
    await db.listen('jobs', () => undefined);
    expect(listenClients[1]!.sent).toEqual(['LISTEN "jobs"']);
  });

  it('runs handlers outside transaction scope and reports their errors', async () => {
    const { db, listenClients, reported, pool } = setup();
    await db.listen('events', async () => {
      await db.query('select 1');
      throw new Error('handler failed');
    });
    await db.tx(async () => {
      listenClients[0]!.notify('events', 'x');
    });
    await eventually(() => reported.length === 1);
    expect((reported[0]![0] as Error).message).toBe('handler failed');
    expect(reported[0]![1]).toBe('listener on "events"');
    expect(pool.sent).toEqual([ext('select 1')]);
  });

  it('validates channels', async () => {
    const { db, listenClients } = setup();
    await expect(db.listen('bad-channel', () => undefined)).rejects.toThrow(/invalid channel/);
    expect(listenClients).toHaveLength(0);
  });
});

describe('lifecycle', () => {
  it('close ends the pool and the LISTEN client, stops reconnecting, and blocks further use', async () => {
    const { db, pool, listenClients } = setup();
    await db.listen('events', () => undefined);
    await db.close();
    await db.close();
    expect(pool.ended).toBe(1);
    expect(listenClients[0]!.ended).toBe(true);
    listenClients[0]!.emit('error', new Error('late'));
    await new Promise((r) => setTimeout(r, 20));
    expect(listenClients).toHaveLength(1);
    await expect(db.query('select 1')).rejects.toBeInstanceOf(DbClosedError);
    await expect(db.listen('events', () => undefined)).rejects.toBeInstanceOf(DbClosedError);
  });

  it('reports idle pool client errors instead of crashing', () => {
    const { pool, reported } = setup();
    pool.errorListeners[0]!(new Error('idle client died'));
    expect(reported.map(([, c]) => c)).toEqual(['idle pool client error']);
  });

  it('creating a real pg-backed Db does not connect', async () => {
    const db = createPgDb({ connectionString: 'postgres://user:pass@127.0.0.1:1/none' });
    expect(db.kind).toBe('pg');
    expect(db.local).toBe(false);
    await db.close();
  });

  it('createDb picks pg when DATABASE_URL is set', async () => {
    const remote = await createDb({ DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/none' });
    expect([remote.kind, remote.local]).toEqual(['pg', false]);
    await remote.close();
    const local = await createDb({ DATABASE_URL: ' postgres://127.0.0.1:1/none ', PACELINE_DB_LOCAL: 'true' });
    expect([local.kind, local.local]).toEqual(['pg', true]);
    await local.close();
  });

  it('createDb falls back to PGlite', async () => {
    const db = await createDb({ DATABASE_URL: '  ', PACELINE_DATA_DIR: 'memory' });
    expect([db.kind, db.local]).toEqual(['pglite', true]);
    expect((await db.query('select 1 as one')).rows).toEqual([{ one: 1 }]);
    await db.close();
  });
});

describe('type parsing (parity with PGlite)', () => {
  it('parses int8 to a number when safe, else a bigint', () => {
    expect(parseInt8('42')).toBe(42);
    expect(parseInt8('-9007199254740991')).toBe(-9007199254740991);
    expect(parseInt8('9007199254740993')).toBe(9007199254740993n);
  });

  it('parses date as UTC midnight', () => {
    expect(parseDate('2024-03-05')).toEqual(new Date('2024-03-05T00:00:00.000Z'));
  });

  it('overrides int8, int8[], date and date[]; keeps pg built-ins otherwise', () => {
    const parsers = new PgTypeParsers();
    const get = parsers.config.getTypeParser as unknown as (oid: number, format?: string) => (v: string) => unknown;
    expect(get(20)('7')).toBe(7);
    expect(get(1016)('{1,NULL,9007199254740993}')).toEqual([1, null, 9007199254740993n]);
    expect(get(1082)('2024-01-02')).toEqual(new Date('2024-01-02T00:00:00.000Z'));
    expect(get(1182)('{2024-01-02,NULL}')).toEqual([new Date('2024-01-02T00:00:00.000Z'), null]);
    expect(get(23)('5')).toBe(5);
    expect(get(3802)('{"a":1}')).toEqual({ a: 1 });
    expect(get(1700)('1.50')).toBe('1.50');
    expect(get(1009)('{a,"b c"}')).toEqual(['a', 'b c']);
    expect(get(99999)('raw')).toBe('raw');
  });

  it('learns array types from the catalog (e.g. enum arrays) without overriding built-ins', () => {
    const parsers = new PgTypeParsers();
    const get = parsers.config.getTypeParser as unknown as (oid: number) => (v: string) => unknown;
    expect(get(90001)('{calm,busy}')).toBe('{calm,busy}');
    const added = parsers.register([
      { array_oid: 90001, elem_oid: 90000 }, // enum[] -> strings
      { array_oid: 90003, elem_oid: 20 }, // array of int8 domain -> int8 parser
      { array_oid: 1007, elem_oid: 23 }, // int4[] is built in: left alone
    ]);
    expect(added).toBe(2);
    expect(get(90001)('{calm,"very busy",NULL}')).toEqual(['calm', 'very busy', null]);
    expect(get(90003)('{{1,2},{3,4}}')).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(get(1007)('{1,2}')).toEqual([1, 2]);
  });

  it('refreshTypes queries the catalog and registers what it finds', async () => {
    const { db, pool } = setup();
    pool.rows = [{ array_oid: 90011, elem_oid: 90010 }];
    await db.refreshTypes();
    expect(pool.sent).toEqual([ext(ARRAY_TYPES_SQL)]);
  });
});
