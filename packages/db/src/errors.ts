/**
 * Error types and SQLSTATE helpers shared by both adapters.
 */

/** Base class for errors raised by @paceline/db itself (not by Postgres). */
export class DbError extends Error {
  override readonly name: string = 'DbError';
}

/**
 * Thrown when a `Db` method is called inside one of that same `Db`'s
 * transaction callbacks. Use the `tx` argument instead: on PGlite the call
 * would deadlock, and on `pg` it would silently run outside the transaction
 * (and outside the user's RLS context).
 */
export class NestedDbCallError extends DbError {
  override readonly name = 'NestedDbCallError';
  /** The method that was called, e.g. `query` or `asUser`. */
  readonly method: string;
  constructor(method: string) {
    super(
      `db.${method}() was called inside a db.tx/asUser/asService callback; use the tx argument instead ` +
        '(this would deadlock PGlite and bypass the transaction on pg)',
    );
    this.method = method;
  }
}

/** Thrown when a transaction handle is used after its callback finished. */
export class TransactionClosedError extends DbError {
  override readonly name = 'TransactionClosedError';
  constructor() {
    super('transaction handle used after its callback finished; it is only valid inside the callback');
  }
}

/** Thrown when a closed `Db` is used. */
export class DbClosedError extends DbError {
  override readonly name = 'DbClosedError';
  constructor() {
    super('database handle is closed');
  }
}

/** Thrown by `asUser()` when the claims are malformed. Nothing is sent to the database. */
export class InvalidClaimsError extends DbError {
  override readonly name = 'InvalidClaimsError';
}

/** Common SQLSTATE codes, for matching errors from either adapter. */
export const SQLSTATE = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  notNullViolation: '23502',
  checkViolation: '23514',
  exclusionViolation: '23P01',
  /** Also raised for RLS `WITH CHECK` failures ("new row violates row-level security policy"). */
  insufficientPrivilege: '42501',
  undefinedTable: '42P01',
  undefinedFunction: '42883',
  syntaxError: '42601',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  lockNotAvailable: '55P03',
  queryCanceled: '57014',
  invalidTextRepresentation: '22P02',
} as const;

/**
 * Returns the SQLSTATE of a database error from either adapter, or undefined
 * for anything else.
 */
export function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** True when `error` is a Postgres error with the given SQLSTATE. */
export function isSqlState(error: unknown, code: string): boolean {
  return sqlState(error) === code;
}
