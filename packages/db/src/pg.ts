/**
 * `pg` adapter for Postgres/Supabase.
 *
 * - Queries and transactions use a `pg.Pool`. `query()` always uses the
 *   extended protocol (one statement, parameters bound by the server), the
 *   same as PGlite; `exec()` uses the simple protocol for multi-statement SQL.
 * - LISTEN uses one dedicated `pg.Client` that reconnects with backoff and
 *   re-subscribes every channel; `ListenOptions.onReconnect` lets callers
 *   catch up on what they missed.
 * - Type parsing matches PGlite: int8 becomes a number (a bigint beyond 2^53),
 *   `date` becomes a UTC-midnight Date, and arrays of migration-created types
 *   parse into arrays after `refreshTypes()`.
 */
import pg from 'pg';
import { DbClosedError } from './errors.js';
import {
  assertOutsideTx,
  createTxHandle,
  defaultErrorReporter,
  dispatchNotification,
  once,
  runInTxScope,
  type TxDriver,
} from './scope.js';
import {
  anonContextStatements,
  assertChannel,
  listenSql,
  notifyStatement,
  serviceContextStatements,
  unlistenSql,
  userContextStatements,
  type Statement,
} from './sql.js';
import type {
  AuthClaims,
  Db,
  DbErrorReporter,
  ListenOptions,
  NotificationHandler,
  QueryParams,
  QueryResult,
  Tx,
  Unlisten,
} from './types.js';

// ---------------------------------------------------------------------------
// Driver seams (the subset of pg we use; also implemented by test fakes)
// ---------------------------------------------------------------------------

/** A query as sent to `pg`: text, values and the protocol to use. */
export interface PgQueryConfig {
  text: string;
  values?: unknown[];
  /** `'extended'` forces Parse/Bind/Execute even without values. */
  queryMode?: 'extended';
}

/** The parts of a `pg` result the adapter reads. */
export interface PgResultLike {
  rows: unknown[];
  rowCount: number | null;
}

/** The parts of `pg.PoolClient` the adapter uses. */
export interface PgPoolClientLike {
  query(config: PgQueryConfig | string): Promise<PgResultLike>;
  release(destroy?: Error | boolean): void;
}

/** The parts of `pg.Pool` the adapter uses. */
export interface PgPoolLike {
  query(config: PgQueryConfig | string): Promise<PgResultLike>;
  connect(): Promise<PgPoolClientLike>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** A NOTIFY as delivered by `pg.Client`. */
export interface PgNotificationLike {
  channel: string;
  payload?: string | undefined;
}

/** The parts of `pg.Client` the LISTEN connection uses. */
export interface PgListenClientLike {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', listener: (message: PgNotificationLike) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for {@link createPgDb}. */
export interface PgDbOptions {
  /** Postgres connection string for the pool (e.g. Supabase's pooler URL). */
  connectionString: string;
  /**
   * Connection string for the LISTEN connection. LISTEN needs a session (a
   * direct connection or Supavisor's session mode), not transaction pooling.
   * Defaults to `connectionString`.
   */
  listenConnectionString?: string;
  /**
   * Marks the database as local, which makes `migrate()` apply the Supabase
   * shims and `_local_` migrations. Only for a plain local Postgres; never for
   * Supabase. Default false.
   */
  local?: boolean;
  /**
   * `supabase` (never shims) or `postgres` (shims when the `auth` schema is
   * missing or is the shims' own). Default: `postgres` when `local`, else
   * `supabase`.
   */
  flavor?: 'postgres' | 'supabase';
  /** Extra pool settings (size, timeouts, ssl, ...). */
  poolConfig?: Omit<pg.PoolConfig, 'connectionString' | 'types'>;
  /** `application_name` reported to Postgres. Default `paceline`. */
  applicationName?: string;
  /** LISTEN reconnect backoff: starts at `initialDelayMs` (250), doubles, caps at `maxDelayMs` (10000). */
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number };
  /**
   * How often the LISTEN connection is health-checked with `select 1`, so a
   * silently dropped connection is noticed. Default 30000; 0 disables.
   */
  listenHeartbeatMs?: number;
  /** Receives errors with no caller to throw to. Defaults to console.error. */
  onError?: DbErrorReporter;
  /** Test seam: use this pool instead of creating a `pg.Pool`. */
  pool?: PgPoolLike;
  /** Test seam: creates the LISTEN client instead of `new pg.Client(...)`. */
  createListenClient?: () => PgListenClientLike;
}

// ---------------------------------------------------------------------------
// Type parsing (parity with PGlite)
// ---------------------------------------------------------------------------

type TextParser = (value: string) => unknown;

/** pg-types' registry lookup, typed loosely (its typings only accept built-in OIDs). */
const builtinParser = pg.types.getTypeParser as unknown as (oid: number, format?: 'text' | 'binary') => TextParser;

const OID = { int8: 20, int8Array: 1016, text: 25, textArray: 1009, date: 1082, dateArray: 1182 } as const;

/** Parses int8 like PGlite: a number when it is a safe integer, else a bigint. */
export function parseInt8(value: string): number | bigint {
  const big = BigInt(value);
  return big < BigInt(Number.MIN_SAFE_INTEGER) || big > BigInt(Number.MAX_SAFE_INTEGER) ? big : Number(big);
}

/** Parses `date` like PGlite: `new Date('YYYY-MM-DD')`, i.e. UTC midnight. */
export function parseDate(value: string): Date {
  return new Date(value);
}

function mapArray(value: unknown, parse: TextParser): unknown {
  if (Array.isArray(value)) return value.map((item) => mapArray(item, parse));
  return value === null ? null : parse(value as string);
}

/**
 * Type parsers for the pool. Overrides int8/date (and their arrays) to match
 * PGlite and learns array types from the catalog in {@link PgTypeParsers.refresh}.
 */
export class PgTypeParsers {
  readonly #overrides = new Map<number, TextParser>();
  readonly #noParse = builtinParser(0, 'text');
  readonly #textArray = builtinParser(OID.textArray, 'text');

  constructor() {
    this.#overrides.set(OID.int8, parseInt8);
    this.#overrides.set(OID.int8Array, (v) => mapArray(this.#textArray(v), parseInt8));
    this.#overrides.set(OID.date, parseDate);
    this.#overrides.set(OID.dateArray, (v) => mapArray(this.#textArray(v), parseDate));
  }

  /** The text-format parser for `oid`, or undefined when values stay strings. */
  parserFor(oid: number): TextParser | undefined {
    const override = this.#overrides.get(oid);
    if (override) return override;
    const builtin = builtinParser(oid, 'text');
    return builtin === this.#noParse ? undefined : builtin;
  }

  /** The `types` option for `pg.Pool`. */
  get config(): pg.CustomTypesConfig {
    const getTypeParser = (oid: number, format?: string): unknown => {
      if (format === 'binary') return builtinParser(oid, 'binary');
      return this.parserFor(oid) ?? this.#noParse;
    };
    return { getTypeParser: getTypeParser as pg.CustomTypesConfig['getTypeParser'] };
  }

  /**
   * Registers a parser for every array type the built-in parsers don't know
   * (e.g. arrays of enums created by migrations), mirroring PGlite.
   * @param arrays `{array_oid, elem_oid}` rows from `pg_type`.
   */
  register(arrays: ReadonlyArray<{ array_oid: number | bigint; elem_oid: number | bigint }>): number {
    let added = 0;
    for (const row of arrays) {
      const arrayOid = Number(row.array_oid);
      if (this.parserFor(arrayOid)) continue;
      const element = this.parserFor(Number(row.elem_oid)) ?? ((v: string) => v);
      this.#overrides.set(arrayOid, (v) => mapArray(this.#textArray(v), element));
      added++;
    }
    return added;
  }
}

/** Lists array types and their element types, for {@link PgTypeParsers.register}. */
export const ARRAY_TYPES_SQL =
  "select t.oid::int8 as array_oid, t.typelem::int8 as elem_oid from pg_catalog.pg_type t where t.typcategory = 'A' and t.typelem <> 0";

// ---------------------------------------------------------------------------
// LISTEN connection
// ---------------------------------------------------------------------------

interface Subscription {
  readonly handler: NotificationHandler;
  readonly onReconnect: (() => void) | undefined;
}

interface ListenerSettings {
  createClient: () => PgListenClientLike;
  initialDelayMs: number;
  maxDelayMs: number;
  heartbeatMs: number;
  report: DbErrorReporter;
}

/**
 * Owns the dedicated LISTEN connection: connects lazily, re-LISTENs every
 * channel after a reconnect, and dispatches notifications to subscribers.
 */
export class PgListener {
  readonly #settings: ListenerSettings;
  readonly #channels = new Map<string, Set<Subscription>>();
  /** The live connection, once connected and subscribed. */
  #client: PgListenClientLike | undefined;
  /** A connection being set up; its notifications are already delivered. */
  #candidate: PgListenClientLike | undefined;
  /** Channels LISTENed on the current connection. */
  #active = new Set<string>();
  #connecting: Promise<PgListenClientLike> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #attempt = 0;
  #lostConnection = false;
  #closed = false;

  constructor(settings: ListenerSettings) {
    this.#settings = settings;
  }

  /** Channels with at least one subscriber. */
  get channels(): string[] {
    return [...this.#channels.keys()];
  }

  /** Subscribes `handler` to `channel`, connecting and issuing LISTEN as needed. */
  async add(channel: string, handler: NotificationHandler, options: ListenOptions = {}): Promise<Unlisten> {
    if (this.#closed) throw new DbClosedError();
    const subscription: Subscription = { handler, onReconnect: options.onReconnect };
    let subscribers = this.#channels.get(channel);
    if (!subscribers) {
      subscribers = new Set();
      this.#channels.set(channel, subscribers);
    }
    subscribers.add(subscription);
    try {
      const client = await this.#ensureConnected();
      // A connection made for this call already LISTENed every known channel.
      if (!this.#active.has(channel)) {
        await client.query(listenSql(channel));
        if (client === this.#client) this.#active.add(channel);
      }
    } catch (error) {
      this.#forget(channel, subscription);
      throw error;
    }
    return once(() => this.#remove(channel, subscription));
  }

  /** Closes the connection and stops reconnecting. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#channels.clear();
    this.#stopTimers();
    const connecting = this.#connecting;
    if (connecting) await connecting.catch(() => undefined);
    const client = this.#client;
    this.#client = undefined;
    this.#active.clear();
    if (client) await client.end().catch(() => undefined);
  }

  #forget(channel: string, subscription: Subscription): boolean {
    const subscribers = this.#channels.get(channel);
    if (!subscribers) return false;
    subscribers.delete(subscription);
    if (subscribers.size > 0) return false;
    this.#channels.delete(channel);
    return true;
  }

  async #remove(channel: string, subscription: Subscription): Promise<void> {
    if (!this.#forget(channel, subscription)) return;
    const client = this.#client;
    if (!client || this.#closed || !this.#active.has(channel)) return;
    this.#active.delete(channel);
    try {
      await client.query(unlistenSql(channel));
    } catch (error) {
      // The connection is broken; it will be replaced without this channel.
      this.#settings.report(error, `UNLISTEN "${channel}"`);
    }
  }

  #ensureConnected(): Promise<PgListenClientLike> {
    if (this.#client) return Promise.resolve(this.#client);
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connect(): Promise<PgListenClientLike> {
    const client = this.#settings.createClient();
    this.#candidate = client;
    client.on('notification', (message) => {
      if (client === this.#client || client === this.#candidate) this.#deliver(message);
    });
    client.on('error', (error) => this.#onConnectionLost(client, error));
    client.on('end', () => this.#onConnectionLost(client, undefined));
    const active = new Set<string>();
    try {
      await client.connect();
      // Iterating the live map also picks up channels added while we connect.
      for (const channel of this.#channels.keys()) {
        await client.query(listenSql(channel));
        active.add(channel);
      }
      if (this.#closed) throw new DbClosedError();
    } catch (error) {
      if (this.#candidate === client) this.#candidate = undefined;
      await client.end().catch(() => undefined);
      throw error;
    }
    this.#candidate = undefined;
    this.#client = client;
    this.#active = active;
    this.#attempt = 0;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#startHeartbeat(client);
    if (this.#lostConnection) {
      this.#lostConnection = false;
      this.#notifyReconnected();
    }
    return client;
  }

  #deliver(message: PgNotificationLike): void {
    const subscribers = this.#channels.get(message.channel);
    if (!subscribers) return;
    const context = `listener on "${message.channel}"`;
    for (const { handler } of subscribers) {
      dispatchNotification(handler, message.payload ?? '', this.#settings.report, context);
    }
  }

  #notifyReconnected(): void {
    const hooks = new Set<() => void>();
    for (const subscribers of this.#channels.values()) {
      for (const { onReconnect } of subscribers) if (onReconnect) hooks.add(onReconnect);
    }
    for (const hook of hooks) dispatchNotification(() => hook(), '', this.#settings.report, 'listen onReconnect hook');
  }

  #onConnectionLost(client: PgListenClientLike, error: Error | undefined): void {
    if (client !== this.#client) return;
    this.#client = undefined;
    this.#active.clear();
    this.#stopHeartbeat();
    client.end().catch(() => undefined);
    if (this.#closed) return;
    this.#lostConnection = true;
    if (error) this.#settings.report(error, 'LISTEN connection lost');
    if (this.#channels.size > 0) this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#retryTimer) return;
    const { initialDelayMs, maxDelayMs } = this.#settings;
    const base = Math.min(maxDelayMs, initialDelayMs * 2 ** this.#attempt);
    const delay = Math.round(base * (0.5 + Math.random() / 2));
    this.#attempt++;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (this.#closed || this.#client || this.#channels.size === 0) return;
      this.#ensureConnected().catch((error: unknown) => {
        if (this.#closed) return;
        this.#settings.report(error, 'LISTEN reconnect failed');
        this.#scheduleReconnect();
      });
    }, delay);
    this.#retryTimer.unref?.();
  }

  #startHeartbeat(client: PgListenClientLike): void {
    this.#stopHeartbeat();
    if (this.#settings.heartbeatMs <= 0) return;
    this.#heartbeat = setInterval(() => {
      client.query('select 1').catch((error: unknown) => {
        this.#onConnectionLost(client, error instanceof Error ? error : new Error(String(error)));
      });
    }, this.#settings.heartbeatMs);
    this.#heartbeat.unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  #stopTimers(): void {
    this.#stopHeartbeat();
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** A {@link Db} backed by `pg`. */
export interface PgDb extends Db {
  readonly kind: 'pg';
  readonly flavor: 'postgres' | 'supabase';
}

/** Builds the config object for one extended-protocol query. */
export function extendedQuery(text: string, params?: QueryParams): PgQueryConfig {
  return { text, values: params ? [...params] : [], queryMode: 'extended' };
}

function toResult<T>(result: PgResultLike): QueryResult<T> {
  return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
}

function clientDriver(client: PgPoolClientLike): TxDriver {
  return {
    async query<T>(sql: string, params?: QueryParams) {
      return toResult<T>(await client.query(extendedQuery(sql, params)));
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

/**
 * Creates a `pg`-backed {@link Db}. Nothing connects until the first query
 * (or `listen()`), so creating one never touches the network.
 */
export function createPgDb(options: PgDbOptions): PgDb {
  return new PgDbImpl(options);
}

class PgDbImpl implements PgDb {
  readonly kind = 'pg' as const;
  readonly flavor: 'postgres' | 'supabase';
  readonly local: boolean;
  readonly #pool: PgPoolLike;
  readonly #listener: PgListener;
  readonly #types: PgTypeParsers;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(options: PgDbOptions) {
    const report = options.onError ?? defaultErrorReporter;
    const applicationName = options.applicationName ?? 'paceline';
    this.local = options.local ?? false;
    this.flavor = options.flavor ?? (this.local ? 'postgres' : 'supabase');
    this.#types = new PgTypeParsers();
    this.#pool =
      options.pool ??
      (new pg.Pool({
        application_name: applicationName,
        ...options.poolConfig,
        connectionString: options.connectionString,
        types: this.#types.config,
      }) as unknown as PgPoolLike);
    this.#pool.on('error', (error) => report(error, 'idle pool client error'));
    const listenConnectionString = options.listenConnectionString ?? options.connectionString;
    this.#listener = new PgListener({
      createClient:
        options.createListenClient ??
        (() =>
          new pg.Client({
            application_name: `${applicationName}-listen`,
            ...pickClientConfig(options.poolConfig),
            connectionString: listenConnectionString,
            keepAlive: true,
          }) as unknown as PgListenClientLike),
      initialDelayMs: options.reconnect?.initialDelayMs ?? 250,
      maxDelayMs: options.reconnect?.maxDelayMs ?? 10_000,
      heartbeatMs: options.listenHeartbeatMs ?? 30_000,
      report,
    });
  }

  #enter(method: string): void {
    if (this.#closed) throw new DbClosedError();
    assertOutsideTx(this, method);
  }

  async query<T = Record<string, unknown>>(sql: string, params?: QueryParams): Promise<QueryResult<T>> {
    this.#enter('query');
    return toResult<T>(await this.#pool.query(extendedQuery(sql, params)));
  }

  async exec(sql: string): Promise<void> {
    this.#enter('exec');
    await this.#pool.query(sql);
  }

  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#transaction('tx', [], fn);
  }

  async asUser<T>(claims: AuthClaims, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#transaction('asUser', userContextStatements(claims), fn);
  }

  async asService<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#transaction('asService', serviceContextStatements(), fn);
  }

  async asAnon<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#transaction('asAnon', anonContextStatements(), fn);
  }

  async #transaction<T>(method: string, prelude: Statement[], fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.#enter(method);
    const client = await this.#pool.connect();
    const driver = clientDriver(client);
    let destroy: Error | undefined;
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      for (const stmt of prelude) await driver.query(stmt.text, stmt.params);
      const handle = createTxHandle(driver);
      let result: T;
      try {
        result = await runInTxScope(this, () => fn(handle.tx));
      } finally {
        handle.close();
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // The connection is unusable; make the pool discard it.
          destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
      } else {
        destroy = error instanceof Error ? error : new Error(String(error));
      }
      throw error;
    } finally {
      client.release(destroy);
    }
  }

  async listen(channel: string, handler: NotificationHandler, options?: ListenOptions): Promise<Unlisten> {
    assertChannel(channel);
    this.#enter('listen');
    return this.#listener.add(channel, handler, options);
  }

  async notify(channel: string, payload: string): Promise<void> {
    const stmt = notifyStatement(channel, payload);
    this.#enter('notify');
    await this.#pool.query(extendedQuery(stmt.text, stmt.params));
  }

  async refreshTypes(): Promise<void> {
    this.#enter('refreshTypes');
    const result = await this.#pool.query(extendedQuery(ARRAY_TYPES_SQL));
    this.#types.register(result.rows as Array<{ array_oid: number; elem_oid: number }>);
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#closed = true;
      await this.#listener.close();
      await this.#pool.end();
    })();
    return this.#closing;
  }
}

/** Connection settings from the pool config that also apply to the LISTEN client. */
function pickClientConfig(config: PgDbOptions['poolConfig']): pg.ClientConfig {
  if (!config) return {};
  const { ssl, user, password, host, port, database, connectionTimeoutMillis, options } = config;
  const picked: pg.ClientConfig = {};
  if (ssl !== undefined) picked.ssl = ssl;
  if (user !== undefined) picked.user = user;
  if (password !== undefined) picked.password = password;
  if (host !== undefined) picked.host = host;
  if (port !== undefined) picked.port = port;
  if (database !== undefined) picked.database = database;
  if (connectionTimeoutMillis !== undefined) picked.connectionTimeoutMillis = connectionTimeoutMillis;
  if (options !== undefined) picked.options = options;
  return picked;
}
