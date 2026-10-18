/**
 * Core types for @paceline/db.
 *
 * Every adapter (PGlite for tests and local dev, `pg` for Postgres/Supabase)
 * implements {@link Db}. Code written against this interface behaves the same
 * on both, including the guard that rejects using `db` inside one of its own
 * transactions (which would deadlock PGlite and bypass RLS on `pg`).
 */

/** A result row. Column names map to parsed values. */
export type Row = Record<string, unknown>;

/** Values accepted as query parameters. Serialized by the driver. */
export type QueryParams = readonly unknown[];

/** Result of {@link Queryable.query}. */
export interface QueryResult<T = Row> {
  /** Parsed rows, in order. Empty for statements that return no rows. */
  rows: T[];
  /**
   * Rows returned (SELECT) or affected (INSERT/UPDATE/DELETE) by the statement.
   */
  rowCount: number;
}

/** Something SQL can be sent to: a {@link Db} or a {@link Tx}. */
export interface Queryable {
  /**
   * Runs ONE parameterized statement (`$1`, `$2`, ...) using the extended
   * protocol. Multiple statements in one call are rejected on both adapters.
   * Never interpolate values into `sql`; pass them in `params`.
   */
  query<T = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  /**
   * Runs one or more statements with the simple protocol. No parameters, no
   * results. Meant for DDL, migrations and fixtures.
   */
  exec(sql: string): Promise<void>;
}

/**
 * A transaction handle passed to the callbacks of {@link Db.tx},
 * {@link Db.asUser} and {@link Db.asService}. It is only valid while the
 * callback runs; using it afterwards throws.
 */
export interface Tx extends Queryable {}

/**
 * JWT claims for a user-scoped transaction. They become
 * `request.jwt.claims`, so Supabase-style policies see them through
 * `auth.uid()`, `auth.role()` and `auth.jwt()`.
 */
export interface AuthClaims {
  /** The user's id (`auth.users.id`), a UUID. Returned by `auth.uid()`. */
  sub: string;
  /**
   * Always `'authenticated'`; {@link Db.asUser} sets it. Accepted here only so
   * a decoded token's claims can be passed through unchanged.
   */
  role?: 'authenticated';
  /** The acting agent, when the request comes from an agent install. */
  agent_id?: string;
  /** The machine credential (`installs.id`) the request was made with. */
  install_id?: string;
  /** How the caller authenticated, e.g. `web`, `install`, `oauth`, `slack`. */
  via?: string;
}

/** The exact JSON object stored in `request.jwt.claims` by {@link Db.asUser}. */
export interface JwtClaims {
  sub: string;
  role: 'authenticated';
  agent_id?: string;
  install_id?: string;
  via?: string;
}

/** Receives the payload of a NOTIFY on a channel. */
export type NotificationHandler = (payload: string) => void | Promise<void>;

/** Stops a {@link Db.listen} subscription. Safe to call more than once. */
export type Unlisten = () => Promise<void>;

/** Options for {@link Db.listen}. */
export interface ListenOptions {
  /**
   * Called after the LISTEN connection was lost and re-established. NOTIFYs
   * sent while it was down are gone, so use this to catch up from a durable
   * cursor (e.g. the `events` table). Never called on PGlite.
   */
  onReconnect?: () => void;
}

/** Which adapter backs a {@link Db}. */
export type DbKind = 'pglite' | 'pg';

/**
 * A database handle. All user-scoped work goes through {@link Db.asUser} so
 * row-level security applies (invariant I7).
 */
export interface Db extends Queryable {
  /** The adapter in use. */
  readonly kind: DbKind;
  /**
   * True for local databases (PGlite, or Postgres flagged local). Migrations
   * whose file name contains `_local_`, and the built-in Supabase shims, are
   * applied only when this is true.
   */
  readonly local: boolean;
  /**
   * Runs `fn` in a transaction (BEGIN ... COMMIT). If `fn` throws, the
   * transaction is rolled back and the error rethrown. Inside `fn`, use the
   * `tx` argument: calling methods on this `Db` throws.
   */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` in a transaction as the `authenticated` role with
   * `request.jwt.claims` set to `{sub, role: 'authenticated', agent_id?,
   * install_id?, via?}`, so RLS policies apply and `auth.uid()` returns
   * `claims.sub`. Both settings are transaction-local.
   */
  asUser<T>(claims: AuthClaims, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` in a transaction as `service_role`, which has BYPASSRLS. For
   * worker jobs only. `auth.role()` returns `'service_role'` inside.
   */
  asService<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` in a transaction as the `anon` role (signed-out callers): RLS
   * applies, `auth.uid()` is null and `auth.role()` is `'anon'`. Use it for
   * public reads instead of `asService`.
   */
  asAnon<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Subscribes to NOTIFYs on `channel` (a lowercase SQL identifier such as
   * `paceline_events`). Resolves once the subscription is active. The handler
   * runs outside any transaction scope; errors it throws are reported, not
   * propagated.
   */
  listen(channel: string, handler: NotificationHandler, options?: ListenOptions): Promise<Unlisten>;
  /**
   * Sends `pg_notify(channel, payload)` outside a transaction. To notify as
   * part of a transaction (delivered on commit), use `notifyIn(tx, ...)`.
   */
  notify(channel: string, payload: string): Promise<void>;
  /**
   * Re-reads array types from the catalog so arrays of types created by
   * migrations (enums, domains) parse into JS arrays on both adapters.
   * `migrate()` calls it for you.
   */
  refreshTypes(): Promise<void>;
  /** Closes the database (PGlite) or the pool and LISTEN connection (pg). Idempotent. */
  close(): Promise<void>;
}

/** Reports errors that have no caller to throw to (listener callbacks, idle pool clients). */
export type DbErrorReporter = (error: unknown, context: string) => void;
