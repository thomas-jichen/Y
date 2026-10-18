/**
 * SQL building shared by both adapters: the statements that set up a user or
 * service context, LISTEN/UNLISTEN/NOTIFY, and the validation behind them.
 * Kept pure so the exact SQL each adapter sends can be unit-tested.
 */
import { DbError, InvalidClaimsError } from './errors.js';
import type { AuthClaims, JwtClaims, Queryable, QueryParams } from './types.js';

/** One statement plus its parameters. */
export interface Statement {
  text: string;
  params?: QueryParams;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPTIONAL_CLAIMS = ['agent_id', 'install_id', 'via'] as const;
const ALLOWED_CLAIM_KEYS = new Set<string>(['sub', 'role', ...OPTIONAL_CLAIMS]);
const MAX_CLAIM_LENGTH = 256;

/** The statement that stores claims as transaction-local `request.jwt.claims`. */
export const SET_CLAIMS_SQL = "select set_config('request.jwt.claims', $1, true)";
/** The statement used by `notify()` and `notifyIn()`. */
export const NOTIFY_SQL = 'select pg_notify($1, $2)';
/** Claims stored by `asService()`, so `auth.role()` returns `'service_role'`. */
export const SERVICE_CLAIMS_JSON = '{"role":"service_role"}';
/** Claims stored by `asAnon()`, so `auth.role()` returns `'anon'`. */
export const ANON_CLAIMS_JSON = '{"role":"anon"}';
/** Postgres rejects NOTIFY payloads of 8000 bytes or more. */
export const MAX_NOTIFY_PAYLOAD_BYTES = 7999;

/**
 * Validates claims and returns the canonical JWT claims object:
 * `{sub, role: 'authenticated', agent_id?, install_id?, via?}`.
 * @throws InvalidClaimsError when `sub` is not a UUID, an optional claim is
 *   not a non-empty string, `role` is not `'authenticated'`, or an unknown key
 *   is present.
 */
export function normalizeClaims(claims: AuthClaims): JwtClaims {
  if (typeof claims !== 'object' || claims === null) {
    throw new InvalidClaimsError('claims must be an object');
  }
  for (const key of Object.keys(claims)) {
    if (!ALLOWED_CLAIM_KEYS.has(key)) {
      throw new InvalidClaimsError(`unknown claim "${key}"; allowed: ${[...ALLOWED_CLAIM_KEYS].join(', ')}`);
    }
  }
  if (typeof claims.sub !== 'string' || !UUID_RE.test(claims.sub)) {
    throw new InvalidClaimsError('claims.sub must be a UUID (auth.users.id)');
  }
  if (claims.role !== undefined && claims.role !== 'authenticated') {
    throw new InvalidClaimsError(`claims.role must be "authenticated" when given, got ${JSON.stringify(claims.role)}`);
  }
  const out: JwtClaims = { sub: claims.sub.toLowerCase(), role: 'authenticated' };
  for (const key of OPTIONAL_CLAIMS) {
    const value: unknown = claims[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CLAIM_LENGTH) {
      throw new InvalidClaimsError(`claims.${key} must be a non-empty string of at most ${MAX_CLAIM_LENGTH} characters`);
    }
    out[key] = value;
  }
  return out;
}

/** Serializes validated claims to the JSON stored in `request.jwt.claims`. */
export function serializeClaims(claims: AuthClaims): string {
  return JSON.stringify(normalizeClaims(claims));
}

/**
 * The statements `asUser()` runs right after BEGIN, in order:
 * `set local role authenticated`, then the claims as a transaction-local
 * setting. Validates the claims first.
 */
export function userContextStatements(claims: AuthClaims): Statement[] {
  return [
    { text: 'set local role authenticated' },
    { text: SET_CLAIMS_SQL, params: [serializeClaims(claims)] },
  ];
}

/** The statements `asService()` runs right after BEGIN, in order. */
export function serviceContextStatements(): Statement[] {
  return [
    { text: 'set local role service_role' },
    { text: SET_CLAIMS_SQL, params: [SERVICE_CLAIMS_JSON] },
  ];
}

/** The statements `asAnon()` runs right after BEGIN, in order. */
export function anonContextStatements(): Statement[] {
  return [
    { text: 'set local role anon' },
    { text: SET_CLAIMS_SQL, params: [ANON_CLAIMS_JSON] },
  ];
}

/**
 * Quotes a SQL identifier (`"name"`, inner quotes doubled).
 * @throws DbError for empty names or names containing NUL.
 */
export function quoteIdent(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new DbError(`invalid SQL identifier ${JSON.stringify(name)}`);
  }
  return `"${name.replaceAll('"', '""')}"`;
}

const CHANNEL_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Validates a LISTEN/NOTIFY channel name. Channels must be lowercase SQL
 * identifiers (`^[a-z_][a-z0-9_]{0,62}$`) so that LISTEN, `pg_notify()` and
 * PGlite's channel handling all agree on the name.
 * @returns the channel, unchanged.
 * @throws DbError for anything else.
 */
export function assertChannel(channel: string): string {
  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) {
    throw new DbError(`invalid channel ${JSON.stringify(channel)}: use a lowercase identifier matching ${CHANNEL_RE}`);
  }
  return channel;
}

/**
 * Validates a NOTIFY payload (a string under 8000 bytes).
 * @throws DbError otherwise.
 */
export function assertPayload(payload: string): string {
  if (typeof payload !== 'string') throw new DbError('notify payload must be a string');
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > MAX_NOTIFY_PAYLOAD_BYTES) {
    throw new DbError(`notify payload is ${bytes} bytes; Postgres allows at most ${MAX_NOTIFY_PAYLOAD_BYTES}`);
  }
  return payload;
}

/** `LISTEN "<channel>"` for a validated channel. */
export function listenSql(channel: string): string {
  return `LISTEN ${quoteIdent(assertChannel(channel))}`;
}

/** `UNLISTEN "<channel>"` for a validated channel. */
export function unlistenSql(channel: string): string {
  return `UNLISTEN ${quoteIdent(assertChannel(channel))}`;
}

/** The NOTIFY statement for a channel and payload, validated. */
export function notifyStatement(channel: string, payload: string): Statement {
  return { text: NOTIFY_SQL, params: [assertChannel(channel), assertPayload(payload)] };
}

/**
 * Sends a NOTIFY through `q`. Inside a transaction the notification is
 * delivered on commit and dropped on rollback, which makes it the right way to
 * announce rows written in the same transaction.
 */
export async function notifyIn(q: Queryable, channel: string, payload: string): Promise<void> {
  const stmt = notifyStatement(channel, payload);
  await q.query(stmt.text, stmt.params);
}
