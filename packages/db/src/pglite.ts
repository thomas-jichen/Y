/**
 * PGlite adapter: in-process WASM Postgres for tests and local development.
 *
 * PGlite is a single connection. Its own locking serializes queries and
 * transactions, so a plain `db.query()` waits for an open transaction instead
 * of joining it. The flip side is that calling `db.*` inside a transaction
 * callback would wait forever; the scope guard turns that into an error.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite, type Extensions, type Results, type Transaction } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { vector } from '@electric-sql/pglite-pgvector';
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
  notifyStatement,
  serviceContextStatements,
  userContextStatements,
  type Statement,
} from './sql.js';
import type {
  AuthClaims,
  Db,
  DbErrorReporter,
  NotificationHandler,
  QueryParams,
  QueryResult,
  Tx,
  Unlisten,
} from './types.js';

/** Options for {@link createPgliteDb}. */
export interface PgliteDbOptions {
  /**
   * A directory to persist the database in (created if missing), or
   * `'memory'` (the default) for a throwaway in-memory database.
   */
  dataDir?: string | 'memory';
  /** Also load the pgTAP extension bundle (needed to `create extension pgtap`). */
  pgtap?: boolean;
  /**
   * Start from this data directory tarball (from `dumpDataDir()`) instead of
   * an empty cluster. Only valid with an in-memory database.
   */
  loadDataDir?: Blob;
  /** Receives errors thrown by listener callbacks. Defaults to console.error. */
  onError?: DbErrorReporter;
}

/** A {@link Db} backed by PGlite, with access to the underlying instance. */
export interface PgliteDb extends Db {
  readonly kind: 'pglite';
  readonly local: true;
  /** `'memory'` or the absolute data directory. */
  readonly dataDir: string | 'memory';
  /** The raw PGlite instance, for dumps and protocol-level access. Bypasses the scope guard. */
  readonly pglite: PGlite;
}

/**
 * PGlite's default startup parameters, with Supabase's search_path
 * (`"$user", public, extensions`) instead of `public`. PGlite runs Postgres in
 * single-user mode, which ignores `ALTER DATABASE ... SET`, so this is the
 * only way to make the setting stick.
 */
export function pgliteStartParams(): string[] {
  return PGlite.defaultStartParams.map((param) =>
    param.startsWith('search_path=') ? 'search_path="$user", public, extensions' : param,
  );
}

/**
 * The extension bundles loaded into every PGlite instance: pgvector, pg_trgm,
 * citext, pgcrypto and uuid-ossp (the last two are enabled by default on
 * Supabase), plus pgTAP when requested. Loading a bundle only makes
 * `create extension` possible; migrations still create the extensions.
 */
export async function pgliteExtensions(options: { pgtap?: boolean } = {}): Promise<Extensions> {
  const extensions: Extensions = { vector, pg_trgm, citext, pgcrypto, uuid_ossp };
  if (options.pgtap) {
    const { pgtap } = await import('@electric-sql/pglite-pgtap');
    extensions.pgtap = pgtap;
  }
  return extensions;
}

function toResult<T>(result: Results<T>): QueryResult<T> {
  return { rows: result.rows, rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length };
}

function driverFor(target: PGlite | Transaction): TxDriver {
  return {
    async query<T>(sql: string, params?: QueryParams) {
      return toResult(await target.query<T>(sql, params ? [...params] : undefined));
    },
    async exec(sql: string) {
      await target.exec(sql);
    },
  };
}

/**
 * Opens a PGlite database. In-memory by default; pass `dataDir` to persist.
 * Two processes must never open the same `dataDir` at once.
 */
export async function createPgliteDb(options: PgliteDbOptions = {}): Promise<PgliteDb> {
  const dataDir = options.dataDir === undefined || options.dataDir === 'memory' ? 'memory' : resolve(options.dataDir);
  if (options.loadDataDir && dataDir !== 'memory') {
    throw new TypeError('loadDataDir can only be used with an in-memory PGlite database');
  }
  if (dataDir !== 'memory') mkdirSync(dataDir, { recursive: true });

  const pglite = await PGlite.create({
    ...(dataDir === 'memory' ? {} : { dataDir }),
    ...(options.loadDataDir ? { loadDataDir: options.loadDataDir } : {}),
    extensions: await pgliteExtensions({ pgtap: options.pgtap ?? false }),
    startParams: pgliteStartParams(),
  });
  return new PgliteDbImpl(pglite, dataDir, options.onError ?? defaultErrorReporter);
}

class PgliteDbImpl implements PgliteDb {
  readonly kind = 'pglite' as const;
  readonly local = true as const;
  readonly #driver: TxDriver;
  readonly #report: DbErrorReporter;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(
    readonly pglite: PGlite,
    readonly dataDir: string | 'memory',
    report: DbErrorReporter,
  ) {
    this.#driver = driverFor(pglite);
    this.#report = report;
  }

  #enter(method: string): void {
    if (this.#closed) throw new DbClosedError();
    assertOutsideTx(this, method);
  }

  async query<T = Record<string, unknown>>(sql: string, params?: QueryParams): Promise<QueryResult<T>> {
    this.#enter('query');
    return this.#driver.query<T>(sql, params);
  }

  async exec(sql: string): Promise<void> {
    this.#enter('exec');
    await this.#driver.exec(sql);
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
    return this.pglite.transaction(async (ptx) => {
      const driver = driverFor(ptx);
      for (const stmt of prelude) await driver.query(stmt.text, stmt.params);
      const handle = createTxHandle(driver);
      try {
        return await runInTxScope(this, () => fn(handle.tx));
      } finally {
        handle.close();
      }
    });
  }

  async listen(channel: string, handler: NotificationHandler): Promise<Unlisten> {
    assertChannel(channel);
    this.#enter('listen');
    const context = `listener on "${channel}"`;
    const callback = (payload: string): void => dispatchNotification(handler, payload, this.#report, context);
    const unlisten = await this.pglite.listen(channel, callback);
    return once(async () => {
      if (this.#closed) return;
      assertOutsideTx(this, 'unlisten');
      await unlisten();
    });
  }

  async notify(channel: string, payload: string): Promise<void> {
    const stmt = notifyStatement(channel, payload);
    this.#enter('notify');
    await this.#driver.query(stmt.text, stmt.params);
  }

  async refreshTypes(): Promise<void> {
    this.#enter('refreshTypes');
    await this.pglite.refreshArrayTypes();
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#closed = true;
      if (!this.pglite.closed) await this.pglite.close();
    })();
    return this.#closing;
  }
}
