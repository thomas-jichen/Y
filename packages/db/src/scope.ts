/**
 * Transaction scoping shared by both adapters.
 *
 * - Detects `db.query()` (or any other `db` method) called inside one of the
 *   same db's transaction callbacks, which deadlocks PGlite (one connection,
 *   one transaction lock) and silently escapes the transaction on `pg`.
 * - Wraps driver transaction objects so a handle cannot be used after its
 *   callback finished (on `pg` the connection is back in the pool by then).
 * - Runs listener callbacks outside any transaction scope.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { NestedDbCallError, TransactionClosedError } from './errors.js';
import type { DbErrorReporter, NotificationHandler, QueryParams, QueryResult, Tx } from './types.js';

interface Scope {
  readonly owner: object;
  active: boolean;
  readonly parent: Scope | undefined;
}

const storage = new AsyncLocalStorage<Scope>();

/**
 * Throws {@link NestedDbCallError} when called (directly or through awaited
 * async work) from inside an active transaction callback of `owner`.
 */
export function assertOutsideTx(owner: object, method: string): void {
  for (let scope = storage.getStore(); scope; scope = scope.parent) {
    if (scope.active && scope.owner === owner) throw new NestedDbCallError(method);
  }
}

/**
 * Runs `fn` marked as "inside a transaction of `owner`". The mark is cleared
 * when `fn` settles, so work that outlives the callback (timers, unawaited
 * promises) is not mistaken for nested use.
 */
export async function runInTxScope<T>(owner: object, fn: () => Promise<T>): Promise<T> {
  const scope: Scope = { owner, active: true, parent: storage.getStore() };
  try {
    return await storage.run(scope, fn);
  } finally {
    scope.active = false;
  }
}

/** The subset of a driver transaction/client that a {@link Tx} delegates to. */
export interface TxDriver {
  query<T>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}

/** A {@link Tx} plus the switch that invalidates it. */
export interface TxHandle {
  readonly tx: Tx;
  /** Makes every later call on `tx` throw {@link TransactionClosedError}. */
  close(): void;
}

/** Wraps a driver transaction so it refuses use after {@link TxHandle.close}. */
export function createTxHandle(driver: TxDriver): TxHandle {
  let closed = false;
  const check = (): void => {
    if (closed) throw new TransactionClosedError();
  };
  const tx: Tx = {
    async query<T>(sql: string, params?: QueryParams) {
      check();
      return driver.query<T>(sql, params);
    },
    async exec(sql: string) {
      check();
      await driver.exec(sql);
    },
  };
  return {
    tx,
    close() {
      closed = true;
    },
  };
}

/** Default reporter: logs to stderr. */
export const defaultErrorReporter: DbErrorReporter = (error, context) => {
  console.error(`[@paceline/db] ${context}:`, error);
};

/**
 * Delivers a notification to a handler on a later tick, outside any
 * transaction scope, reporting (never throwing) handler errors.
 */
export function dispatchNotification(
  handler: NotificationHandler,
  payload: string,
  report: DbErrorReporter,
  context: string,
): void {
  storage.exit(() => {
    setImmediate(() => {
      try {
        const result = handler(payload);
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).then(undefined, (error: unknown) => report(error, context));
        }
      } catch (error) {
        report(error, context);
      }
    });
  });
}

/** Runs `fn` with no transaction scope (for callbacks invoked from driver internals). */
export function runOutsideTxScope<T>(fn: () => T): T {
  return storage.exit(fn);
}

/** Wraps an async function so it runs once; later calls return the first call's promise. */
export function once(fn: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= fn();
    return pending;
  };
}
