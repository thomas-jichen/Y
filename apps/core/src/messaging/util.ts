/**
 * Shared helpers for the messaging and internal-mcp modules: error bodies,
 * id mapping (bare ULID in the DB, prefixed on the wire), caller lookup,
 * handle/ref resolution and the relationship between two agents.
 */
import type { Context } from 'hono';
import type { Queryable, Tx } from '@y/db';
import {
  ERROR_HTTP_STATUS,
  ErrorCode,
  UNREAD_POSTS_CAP,
  makeError,
  toPrefixedId,
  parsePrefixedId,
  type ErrorBody,
  type ErrorOptions,
  type IdKind,
  type KillSwitches,
} from '@y/schema';
import type { Caller, CoreDeps } from '../contracts.js';

/** Thrown by handlers; rendered as the standard error body. */
export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly opts: ErrorOptions = {},
  ) {
    super(message);
  }
  get body(): ErrorBody {
    return makeError(this.code, this.message, this.opts);
  }
  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

/**
 * NOT_IMPLEMENTED is not (yet) an ErrorCode in @y/schema. Until it is,
 * cut tools answer NOT_FOUND with a "not implemented" message (HTTP 501).
 */
export const NOT_IMPLEMENTED_CODE: ErrorCode = (ErrorCode.options as readonly string[]).includes('NOT_IMPLEMENTED')
  ? ('NOT_IMPLEMENTED' as ErrorCode)
  : 'NOT_FOUND';

export function notImplemented(what: string): HttpError {
  return new HttpError(NOT_IMPLEMENTED_CODE, `${what} is not implemented in this version`);
}

/** Render an error (HttpError or anything else) as a JSON response. */
export function errorResponse(c: Context, err: unknown, deps: CoreDeps) {
  if (err instanceof HttpError) {
    const status = err.message.includes('not implemented') ? 501 : err.status;
    return c.json(err.body, status as 400);
  }
  deps.log('error', 'handler failed', { err: String(err), path: c.req.path });
  return c.json(makeError('INTERNAL', 'internal error'), 500);
}

export function wire(kind: IdKind, bare: string): string {
  return toPrefixedId(kind, bare);
}

/** Strip the wire prefix, checking the kind. Throws VALIDATION on mismatch. */
export function bare(kind: IdKind, id: string): string {
  const p = parsePrefixedId(id);
  if (!p || p.kind !== kind) throw new HttpError('VALIDATION', `expected a ${kind} id`);
  return p.ulid;
}

export function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return new Date(v).toISOString();
  return new Date(0).toISOString();
}

export function atHandle(h: unknown): string {
  return `@${String(h)}`;
}

/** Bearer → Caller, or 401. */
export async function requireCaller(deps: CoreDeps, authorization: string | undefined): Promise<Caller> {
  const caller = await deps.auth.verifyBearer(authorization);
  if (!caller) throw new HttpError('UNAUTHORIZED', 'missing or invalid credentials');
  return caller;
}

export function requireAgent(caller: Caller): string {
  if (!caller.agentId) throw new HttpError('SCOPE_FORBIDDEN', 'an agent credential is required');
  return caller.agentId;
}

/** A human in the web app (not an agent credential). */
export function requireHuman(caller: Caller): void {
  if (caller.agentId || (caller.via !== 'web' && caller.via !== 'dev')) {
    throw new HttpError('SCOPE_FORBIDDEN', 'only a human in the web app can do this');
  }
}

export interface AgentInfo {
  id: string;
  handle: string;
  harness: string;
  ownerUserId: string;
  ownerHandle: string;
  ownerLogin: string | null;
  ownerAvatar: string | null;
}

/** Identity metadata for agents (handles are public identifiers, no content). */
export async function agentInfos(q: Queryable, ids: readonly string[]): Promise<Map<string, AgentInfo>> {
  const out = new Map<string, AgentInfo>();
  if (ids.length === 0) return out;
  const r = await q.query<{
    id: string; handle: string; harness: string; owner_user_id: string;
    owner_handle: string; github_login: string | null; avatar_url: string | null;
  }>(
    `select a.id, a.handle::text as handle, a.harness::text as harness, a.owner_user_id,
            u.handle::text as owner_handle, u.github_login::text as github_login, u.avatar_url
       from public.agents a join public.users u on u.id = a.owner_user_id
      where a.id = any($1::uuid[])`,
    [ids],
  );
  for (const row of r.rows) {
    out.set(row.id, {
      id: row.id, handle: row.handle, harness: row.harness, ownerUserId: row.owner_user_id,
      ownerHandle: row.owner_handle, ownerLogin: row.github_login, ownerAvatar: row.avatar_url,
    });
  }
  return out;
}

export interface UserInfo { id: string; handle: string; login: string | null; avatar: string | null }

export async function userInfos(q: Queryable, ids: readonly string[]): Promise<Map<string, UserInfo>> {
  const out = new Map<string, UserInfo>();
  if (ids.length === 0) return out;
  const r = await q.query<{ id: string; handle: string; github_login: string | null; avatar_url: string | null }>(
    `select id, handle::text as handle, github_login::text as github_login, avatar_url from public.users where id = any($1::uuid[])`,
    [ids],
  );
  for (const row of r.rows) out.set(row.id, { id: row.id, handle: row.handle, login: row.github_login, avatar: row.avatar_url });
  return out;
}

export function userRef(u: { id: string; handle: string; login: string | null; avatar: string | null }) {
  return { id: u.id, login: u.login ?? u.handle, handle: atHandle(u.handle), avatarUrl: u.avatar ?? '' };
}

export function agentRef(a: AgentInfo) {
  return {
    id: a.id,
    handle: atHandle(a.handle),
    harness: a.harness as 'claude_code',
    owner: userRef({ id: a.ownerUserId, handle: a.ownerHandle, login: a.ownerLogin, avatar: a.ownerAvatar }),
  };
}

export type Relationship = 'self' | 'teammate' | 'stranger';

/** Relationship of a sender owner to a recipient owner (team membership; contacts are cut in v0). */
export async function relationshipBetween(q: Queryable, senderOwnerId: string, recipientOwnerId: string): Promise<Relationship> {
  if (senderOwnerId === recipientOwnerId) return 'self';
  const r = await q.query(
    `select 1 from public.team_members a join public.team_members b on a.team_id = b.team_id
      where a.user_id = $1 and b.user_id = $2 limit 1`,
    [senderOwnerId, recipientOwnerId],
  );
  return r.rowCount > 0 ? 'teammate' : 'stranger';
}

export async function sharedTeamId(q: Queryable, a: string, b: string): Promise<string | null> {
  const r = await q.query<{ team_id: string }>(
    `select a.team_id from public.team_members a join public.team_members b on a.team_id = b.team_id
      where a.user_id = $1 and b.user_id = $2 order by a.team_id limit 1`,
    [a, b],
  );
  return r.rows[0]?.team_id ?? null;
}

export async function killSwitches(q: Queryable): Promise<KillSwitches> {
  const ks: KillSwitches = { pushPaths: false, networkContent: false, apply: false, ingest: false };
  const r = await q.query<{ name: string; engaged: boolean }>(`select name, engaged from public.kill_switches`);
  for (const row of r.rows) {
    if (row.name === 'push_paths') ks.pushPaths = row.engaged;
    if (row.name === 'network_content') ks.networkContent = row.engaged;
    if (row.name === 'apply') ks.apply = row.engaged;
    if (row.name === 'ingest') ks.ingest = row.engaged;
  }
  return ks;
}

/**
 * Unread counts for an agent (service or agent-scoped queryable). `posts`:
 * published team posts by other agents this agent has no exposure of
 * (capped at UNREAD_POSTS_CAP; a count only, I3). Filters are explicit so
 * the service role gets the same answer as RLS.
 */
export async function unreadCounts(q: Queryable, agentId: string, ownerUserId: string) {
  const r = await q.query<{ dm: number; oi: number; rv: number; ps: number }>(
    `select
       (select count(*)::int from public.message_deliveries d join public.messages m on m.id = d.message_id
         where d.recipient_agent_id = $1 and d.state in ('pending','pointer_sent') and m.state in ('delivered','released')) as dm,
       (select count(*)::int from public.owner_instructions o where o.agent_id = $1 and o.delivered_at is null) as oi,
       (select count(*)::int from public.review_items r where r.owner_user_id = $2 and r.state = 'pending') as rv,
       (select count(*)::int from (select 1 from public.posts p
         where p.status = 'published' and p.screen_action in ('allow','label') and p.author_agent_id <> $1
           and p.team_id in (select tm.team_id from public.team_members tm where tm.user_id = $2)
           and not exists (select 1 from public.content_exposures e
                            where e.agent_id = $1 and e.content_kind = 'post' and e.content_id = 'ps_' || p.id)
         limit $3) x) as ps`,
    [agentId, ownerUserId, UNREAD_POSTS_CAP],
  );
  const row = r.rows[0];
  return { dm: row?.dm ?? 0, ownerInstructions: row?.oi ?? 0, reviews: row?.rv ?? 0, suggestions: 0, posts: row?.ps ?? 0 };
}

export type { Tx };
