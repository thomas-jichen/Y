/**
 * Teams web API (packages/schema teams.ts): create a team, invite links,
 * linked GitHub repos. Humans only (web session or Supabase JWT): agent
 * credentials get SCOPE_FORBIDDEN from authenticate(), and RLS needs
 * is_human() for every write (I11). Everything runs through db.asUser (I7).
 *
 * - Creating a team makes the caller its owner (teams_provision trigger) and
 *   opens its team room (9004).
 * - Invites: owners and admins mint, list and revoke (team_invites RLS). The
 *   token is shown once; only its sha256 is stored. Opening a link previews
 *   it; joining is a separate POST behind the Join button (no auto-join, I5).
 * - Repos: linked by name (owner/repo, GitHub naming rules), no proof.
 *   Members read; owners and admins add and remove. GET .../repos/status
 *   matches them to sessions by salted repo key (repo-keys.ts) and returns
 *   names and counts only.
 * - Posting team (9110): the one team a person's agents publish to. Creating
 *   a team moves it there unless `postHere: false`; accepting an invite moves
 *   it only with `postHere: true`; POST /me/posting-team changes it. A second
 *   membership pins the first team (trigger), so nothing moves by itself.
 * - Admin invite links: the owner only, single use, at most 72 h.
 * - Team slugs and repo names reach agents outside envelopes (status), so
 *   they pass the handle label screen (#110, I2) when chosen.
 * - Step-up (I5): invites, accepting, repos and the posting team need a
 *   recent sign-in (web-guard.ts STEP_UP_ROUTES).
 * - /dev/demo sessions cannot create, join or change teams (durable grants, #44).
 */
import { randomBytes } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { isSqlState, type Tx } from '@y/db';
import {
  ADMIN_INVITE_MAX_HOURS,
  AcceptInviteRequest,
  AddTeamRepoRequest,
  CreateInviteRequest,
  CreateTeamRequest,
  InviteTokenRequest,
  SetPostingTeamRequest,
  Slug,
  TEAM_REPOS_MAX,
  TeamReposStatus,
  type AcceptInviteResponse,
  type PostingTeamResponse,
  type CreateInviteResponse,
  type InvitePreview,
  type TeamDetail,
  type TeamInvite,
  type TeamInviteList,
  type TeamRole,
} from '@y/schema';
import type { Caller, CoreDeps } from '../../contracts.js';
import { presenceWindows } from '@y/domain';
import { cleanAsciiLabel, repoLabel } from '../../builders/labels.js';
import { authenticate } from '../http.js';
import { usesRealtimeDoorbell } from '../realtime-channel.js';
import { keyedTeamRepos } from '../repo-keys.js';
import { takeToken, type BucketSpec } from '../rate-limit.js';
import { HttpError, postingTeamId, userRef, wire } from '../../messaging/util.js';
import { fail, iso, parseOr, readJson, sha256Hex } from '../util.js';

/** Team creation: 10 / hour per human. */
export const TEAM_CREATE_BUCKET: BucketSpec = { rate: 10 / 3600, burst: 10 };
/** Active (unrevoked, unexpired, not used up) invites per team. */
export const MAX_ACTIVE_INVITES = 50;
/** Slugs only the server hands out. */
const RESERVED_SLUGS = new Set(['dev']);
const INVITE_PREFIX = 'yti_';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A new invite token: `yti_` + 32 random bytes (base64url, 43 chars). */
export function mintInviteToken(): string {
  return `${INVITE_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** A slug from a team name: lowercase ASCII letters, digits and single dashes (at most 60 chars). */
export function slugFromName(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'team';
}

function inviteUrl(deps: CoreDeps, token: string): string {
  const web = deps.config.slack?.webUrl ?? deps.config.publicUrl;
  return `${web}/join/${token}`;
}

/** The caller's agents post to this team from now on (RLS: their own row, a team they are on, as a human). */
async function setPostingTeam(tx: Tx, caller: Caller, teamId: string): Promise<void> {
  await tx.query(
    `insert into public.user_posting_team (user_id, team_id) values ($1, $2)
     on conflict (user_id) do update set team_id = excluded.team_id, updated_at = now()`,
    [caller.userId, teamId],
  );
}

function assertNotDemo(caller: Caller): void {
  if (caller.demoAccount) throw new HttpError('SCOPE_FORBIDDEN', 'the demo account cannot change teams');
}

interface TeamRow { id: string; slug: string; name: string; role: TeamRole }

/** The team by slug with the caller's role; 404 when the caller is not a member (RLS hides it too). */
async function memberTeam(tx: Tx, caller: Caller, slugParam: string): Promise<TeamRow> {
  const slug = Slug.safeParse(slugParam);
  if (!slug.success) throw new HttpError('NOT_FOUND', 'team not found');
  const r = await tx.query<TeamRow>(
    `select t.id, t.slug::text as slug, t.name, m.role::text as role
       from public.teams t join public.team_members m on m.team_id = t.id and m.user_id = $2
      where t.slug = $1`,
    [slug.data, caller.userId],
  );
  const t = r.rows[0];
  if (!t) throw new HttpError('NOT_FOUND', 'team not found');
  return t;
}

async function adminTeam(tx: Tx, caller: Caller, slugParam: string, what: string): Promise<TeamRow> {
  const t = await memberTeam(tx, caller, slugParam);
  if (t.role !== 'owner' && t.role !== 'admin') throw new HttpError('SCOPE_FORBIDDEN', `only a team owner or admin can ${what}`);
  return t;
}

const ROLE_ORDER = `case m.role when 'owner' then 0 when 'admin' then 1 else 2 end`;

async function teamDetail(tx: Tx, caller: Caller, t: TeamRow): Promise<TeamDetail> {
  const members = await tx.query<{ user_id: string; role: TeamRole; joined_at: Date | string; handle: string; github_login: string | null; avatar_url: string | null }>(
    `select m.user_id, m.role::text as role, m.joined_at, u.handle::text as handle, u.github_login::text as github_login, u.avatar_url
       from public.team_members m join public.users u on u.id = m.user_id
      where m.team_id = $1
      order by ${ROLE_ORDER}, m.joined_at, m.user_id limit 500`,
    [t.id],
  );
  const repos = await tx.query<{ id: string; repo: string; created_at: Date | string; added_by: string | null; handle: string | null; github_login: string | null; avatar_url: string | null }>(
    `select r.id, r.repo, r.created_at, u.id as added_by, u.handle::text as handle, u.github_login::text as github_login, u.avatar_url
       from public.team_repos r left join public.users u on u.id = r.added_by
      where r.team_id = $1
      order by lower(r.repo) limit ${TEAM_REPOS_MAX}`,
    [t.id],
  );
  const room = await tx.query<{ id: string }>(
    `select id from public.threads where kind = 'group' and team_id = $1 and state <> 'archived' order by created_at limit 1`,
    [t.id],
  );
  const posting = await postingTeamId(tx, caller.userId);
  return {
    team: { id: t.id, slug: t.slug, name: t.name },
    viewerRole: t.role,
    roomThreadId: room.rows[0] ? wire('thread', room.rows[0].id) : null,
    postsHere: posting === t.id,
    members: members.rows.map((m) => ({
      user: userRef({ id: m.user_id, handle: m.handle, login: m.github_login, avatar: m.avatar_url }),
      role: m.role,
      joinedAt: iso(m.joined_at),
    })),
    repos: repos.rows.map((r) => ({
      id: r.id,
      repo: r.repo,
      addedBy: r.added_by && r.handle ? userRef({ id: r.added_by, handle: r.handle, login: r.github_login, avatar: r.avatar_url }) : null,
      createdAt: iso(r.created_at),
    })),
  };
}

/**
 * Per linked repo: distinct agents working in it now (api.team_repo_agents, which
 * sees teammates' sessions as counts only) and the latest turn summary or
 * activity in it that the caller can read (RLS). Repo keys never leave core.
 */
async function repoStatus(tx: Tx, deps: CoreDeps, t: TeamRow): Promise<TeamReposStatus> {
  const repos = await keyedTeamRepos(tx, t.id, TEAM_REPOS_MAX);
  const keys = repos.map((r) => r.key);
  const agents = new Map<string, number>();
  const latest = new Map<string, string>();
  let allAgents = 0;
  if (keys.length) {
    const { liveMs, listeningMs, ingestLiveMs } = presenceWindows({ doorbell: usesRealtimeDoorbell(deps.config) });
    const per = await tx.query<{ repo_key: string | null; active_agents: number }>(
      `select repo_key, active_agents
         from api.team_repo_agents($1::uuid, $2::text[], $3::int * interval '1 millisecond',
                                   $4::int * interval '1 millisecond', $5::int * interval '1 millisecond')`,
      [t.id, keys, liveMs, listeningMs, ingestLiveMs],
    );
    for (const r of per.rows) {
      if (r.repo_key === null) allAgents = Number(r.active_agents);
      else agents.set(r.repo_key, Number(r.active_agents));
    }
    const last = await tx.query<{ repo_key: string; at: Date | string | null }>(
      `select k.repo_key, greatest(
                (select max(s.created_at) from public.turn_summaries s where s.team_id = $1 and s.repo_key = k.repo_key),
                (select max(coalesce(a.ended_at, a.started_at)) from public.activities a where a.team_id = $1 and a.repo_key = k.repo_key)
              ) as at
         from unnest($2::text[]) as k(repo_key)`,
      [t.id, keys],
    );
    for (const r of last.rows) if (r.at) latest.set(r.repo_key, iso(r.at));
  }
  const items = repos.map((r) => ({
    repo: r.repo,
    activeAgents: agents.get(r.key) ?? 0,
    ...(latest.has(r.key) ? { lastActivityAt: latest.get(r.key)! } : {}),
  }));
  const newest = items.reduce<string | undefined>((m, x) => (x.lastActivityAt && (!m || x.lastActivityAt > m) ? x.lastActivityAt : m), undefined);
  return {
    team: { id: t.id, slug: t.slug, name: t.name },
    viewerRole: t.role,
    repos: items,
    all: { activeAgents: allAgents, ...(newest ? { lastActivityAt: newest } : {}) },
  };
}

async function listInvites(tx: Tx, teamId: string): Promise<TeamInviteList> {
  const r = await tx.query<{
    id: string; role: TeamInvite['role']; max_uses: number; uses: number; expires_at: Date | string; created_at: Date | string;
    state: TeamInvite['state']; created_by: string | null; handle: string | null; github_login: string | null; avatar_url: string | null;
  }>(
    `select i.id, i.role, i.max_uses, i.uses, i.expires_at, i.created_at,
            case when i.revoked_at is not null then 'revoked'
                 when i.expires_at <= now() then 'expired'
                 when i.uses >= i.max_uses then 'used_up'
                 else 'active' end as state,
            u.id as created_by, u.handle::text as handle, u.github_login::text as github_login, u.avatar_url
       from public.team_invites i left join public.users u on u.id = i.created_by
      where i.team_id = $1
      order by (i.revoked_at is null and i.expires_at > now() and i.uses < i.max_uses) desc, i.created_at desc, i.id
      limit 200`,
    [teamId],
  );
  return {
    items: r.rows.map((i) => ({
      id: i.id,
      role: i.role,
      maxUses: Number(i.max_uses),
      uses: Number(i.uses),
      expiresAt: iso(i.expires_at),
      createdAt: iso(i.created_at),
      createdBy: i.created_by && i.handle ? userRef({ id: i.created_by, handle: i.handle, login: i.github_login, avatar: i.avatar_url }) : null,
      state: i.state,
    })),
  };
}

async function run(c: Context, deps: CoreDeps, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.opts.retryAfterS !== undefined) c.header('retry-after', String(e.opts.retryAfterS));
      return fail(c, e.code, e.message, e.opts);
    }
    if (isSqlState(e, '42501')) return fail(c, 'SCOPE_FORBIDDEN', 'teams are changed by a signed-in human with the right team role');
    if (isSqlState(e, '23505')) return fail(c, 'CONFLICT', 'already taken');
    deps.log('error', 'teams route failed', { err: String(e), path: c.req.path });
    return fail(c, 'INTERNAL', 'internal error');
  }
}

export function registerTeamRoutes(app: Hono, deps: CoreDeps): void {
  /* --------------------------------------------------------- create team */
  app.post('/api/v1/teams', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const body = parseOr(c, CreateTeamRequest, await readJson(c));
    if (!body.ok) return body.res;
    return run(c, deps, async () => {
      assertNotDemo(caller);
      const name = body.data.name.trim();
      const explicit = body.data.slug;
      if (explicit && RESERVED_SLUGS.has(explicit)) throw new HttpError('VALIDATION', `the team URL '${explicit}' is reserved; pick another`);
      // Agents see slugs as plain labels (status team_rooms / team_repos): screened like handles (#110).
      if (explicit && !cleanAsciiLabel(explicit)) throw new HttpError('VALIDATION', 'that team URL is not allowed; pick another');
      const derived = slugFromName(name);
      const base = cleanAsciiLabel(derived) ? derived : 'team';
      // An explicit slug is taken as is; a derived one gets a short suffix while it collides.
      const candidates = explicit
        ? [explicit]
        : [RESERVED_SLUGS.has(base) ? `${base}-team` : base, ...Array.from({ length: 4 }, () => `${base.slice(0, 54)}-${randomBytes(3).toString('hex')}`)];
      for (const slug of candidates) {
        try {
          const detail = await deps.db.asUser(caller.claims, async (tx) => {
            const rl = await takeToken(tx, 'team_create', [caller.userId], TEAM_CREATE_BUCKET);
            if (!rl.allowed) throw new HttpError('RATE_LIMITED', 'too many new teams; try again later', { retryable: true, retryAfterS: rl.retryAfterS });
            // The teams_provision trigger adds the caller as owner; the member trigger opens the team room.
            await tx.query('insert into public.teams (slug, name, created_by) values ($1, $2, $3)', [slug, name, caller.userId]);
            const t = await memberTeam(tx, caller, slug);
            if (body.data.postHere !== false) await setPostingTeam(tx, caller, t.id);
            return teamDetail(tx, caller, t);
          });
          return c.json(detail);
        } catch (e) {
          if (!isSqlState(e, '23505')) throw e;
        }
      }
      throw new HttpError('CONFLICT', explicit ? 'that team URL is taken; pick another' : 'could not find a free team URL; pick one');
    });
  });

  /* ---------------------------------------------------------- team detail */
  app.get('/api/v1/teams/:slug', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    return run(c, deps, async () =>
      c.json(await deps.db.asUser(caller.claims, async (tx) => teamDetail(tx, caller, await memberTeam(tx, caller, c.req.param('slug'))))),
    );
  });

  /* ---------------------------------------------------------------- repos */
  app.post('/api/v1/teams/:slug/repos', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const body = parseOr(c, AddTeamRepoRequest, await readJson(c));
    if (!body.ok) return body.res;
    return run(c, deps, async () => {
      assertNotDemo(caller);
      // Agents see repo names as plain labels in status: screened like handles (#110, I2).
      if (!repoLabel(body.data.repo)) throw new HttpError('VALIDATION', 'that repo name is not allowed');
      const detail = await deps.db.asUser(caller.claims, async (tx) => {
        const t = await adminTeam(tx, caller, c.req.param('slug'), 'link repos');
        const n = await tx.query<{ n: number; has: boolean }>(
          `select count(*)::int as n, coalesce(bool_or(lower(repo) = lower($2)), false) as has from public.team_repos where team_id = $1`,
          [t.id, body.data.repo],
        );
        if (!n.rows[0]?.has) {
          if (Number(n.rows[0]?.n ?? 0) >= TEAM_REPOS_MAX) throw new HttpError('VALIDATION', `a team links at most ${TEAM_REPOS_MAX} repos`);
          await tx.query(
            `insert into public.team_repos (team_id, repo, added_by) values ($1, $2, $3) on conflict do nothing`,
            [t.id, body.data.repo, caller.userId],
          );
        }
        return teamDetail(tx, caller, t);
      });
      return c.json(detail);
    });
  });

  const removeRepo = async (c: Context) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    return run(c, deps, async () => {
      assertNotDemo(caller);
      const id = c.req.param('id') ?? '';
      if (!UUID_RE.test(id)) throw new HttpError('NOT_FOUND', 'repo not found');
      const detail = await deps.db.asUser(caller.claims, async (tx) => {
        const t = await adminTeam(tx, caller, c.req.param('slug') ?? '', 'unlink repos');
        const r = await tx.query('delete from public.team_repos where id = $1 and team_id = $2', [id, t.id]);
        if (r.rowCount === 0) throw new HttpError('NOT_FOUND', 'repo not found');
        return teamDetail(tx, caller, t);
      });
      return c.json(detail);
    });
  };
  app.post('/api/v1/teams/:slug/repos/:id/remove', removeRepo);
  app.delete('/api/v1/teams/:slug/repos/:id', removeRepo);

  // The web's repo bar: agents working in each linked repo now and its latest update (members only).
  app.get('/api/v1/teams/:slug/repos/status', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    return run(c, deps, async () =>
      c.json(
        TeamReposStatus.parse(
          await deps.db.asUser(caller.claims, async (tx) => repoStatus(tx, deps, await memberTeam(tx, caller, c.req.param('slug')))),
        ),
      ),
    );
  });

  /* -------------------------------------------------------------- invites */
  app.get('/api/v1/teams/:slug/invites', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    return run(c, deps, async () =>
      c.json(await deps.db.asUser(caller.claims, async (tx) => listInvites(tx, (await adminTeam(tx, caller, c.req.param('slug'), 'see invites')).id))),
    );
  });

  app.post('/api/v1/teams/:slug/invites', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const body = parseOr(c, CreateInviteRequest, (await readJson(c)) ?? {});
    if (!body.ok) return body.res;
    return run(c, deps, async () => {
      assertNotDemo(caller);
      const token = mintInviteToken();
      const out = await deps.db.asUser(caller.claims, async (tx) => {
        const t = await adminTeam(tx, caller, c.req.param('slug'), 'invite people');
        // An admin link grants admin: the owner only, one use, short-lived.
        const admin = body.data.role === 'admin';
        if (admin && t.role !== 'owner') throw new HttpError('SCOPE_FORBIDDEN', 'only the team owner can invite admins');
        const maxUses = admin ? 1 : body.data.maxUses;
        const hours = admin ? Math.min(body.data.expiresInHours, ADMIN_INVITE_MAX_HOURS) : body.data.expiresInHours;
        const active = await tx.query<{ n: number }>(
          `select count(*)::int as n from public.team_invites
            where team_id = $1 and revoked_at is null and expires_at > now() and uses < max_uses`,
          [t.id],
        );
        if (Number(active.rows[0]?.n ?? 0) >= MAX_ACTIVE_INVITES) {
          throw new HttpError('VALIDATION', `a team has at most ${MAX_ACTIVE_INVITES} active invites; revoke one first`);
        }
        const ins = await tx.query<{ id: string }>(
          `insert into public.team_invites (team_id, token_hash, role, created_by, expires_at, max_uses)
           values ($1, $2, $3, $4, now() + make_interval(hours => $5::int), $6) returning id`,
          [t.id, sha256Hex(token), body.data.role, caller.userId, hours, maxUses],
        );
        const id = ins.rows[0]!.id;
        const invite = (await listInvites(tx, t.id)).items.find((i) => i.id === id);
        if (!invite) throw new Error('invite not readable after insert');
        return invite;
      });
      const res: CreateInviteResponse = { invite: out, token, url: inviteUrl(deps, token) };
      return c.json(res);
    });
  });

  const revokeInvite = async (c: Context) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    return run(c, deps, async () => {
      assertNotDemo(caller);
      const id = c.req.param('id') ?? '';
      if (!UUID_RE.test(id)) throw new HttpError('NOT_FOUND', 'invite not found');
      const list = await deps.db.asUser(caller.claims, async (tx) => {
        const t = await adminTeam(tx, caller, c.req.param('slug') ?? '', 'revoke invites');
        const found = await tx.query<{ revoked: boolean }>(
          'select revoked_at is not null as revoked from public.team_invites where id = $1 and team_id = $2',
          [id, t.id],
        );
        if (!found.rows[0]) throw new HttpError('NOT_FOUND', 'invite not found');
        if (!found.rows[0].revoked) {
          await tx.query('update public.team_invites set revoked_at = now() where id = $1 and team_id = $2 and revoked_at is null', [id, t.id]);
        }
        return listInvites(tx, t.id);
      });
      return c.json(list);
    });
  };
  app.post('/api/v1/teams/:slug/invites/:id/revoke', revokeInvite);
  app.delete('/api/v1/teams/:slug/invites/:id', revokeInvite);

  /* ------------------------------------------------- open an invite link */
  const INVALID = 'This invite link is invalid, used up or expired. Ask a team admin for a new one.';

  app.post('/api/v1/invites/preview', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const body = parseOr(c, InviteTokenRequest, await readJson(c));
    if (!body.ok) return body.res;
    return run(c, deps, async () => {
      const row = await deps.db.asUser(caller.claims, async (tx) =>
        (await tx.query<{ team_id: string; slug: string; name: string; role: InvitePreview['role']; expires_at: Date | string; already_member: boolean }>(
          'select * from api.preview_team_invite($1)', [sha256Hex(body.data.token)])).rows[0],
      );
      if (!row) throw new HttpError('NOT_FOUND', INVALID);
      const out: InvitePreview = {
        team: { id: row.team_id, slug: row.slug, name: row.name },
        role: row.role,
        expiresAt: iso(row.expires_at),
        alreadyMember: Boolean(row.already_member),
      };
      return c.json(out);
    });
  });

  app.post('/api/v1/invites/accept', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const body = parseOr(c, AcceptInviteRequest, await readJson(c));
    if (!body.ok) return body.res;
    return run(c, deps, async () => {
      assertNotDemo(caller);
      const hash = sha256Hex(body.data.token);
      const out = await deps.db.asUser(caller.claims, async (tx): Promise<AcceptInviteResponse> => {
        const pre = (await tx.query<{ team_id: string; already_member: boolean }>('select team_id, already_member from api.preview_team_invite($1)', [hash])).rows[0];
        if (!pre) throw new HttpError('NOT_FOUND', INVALID);
        let joined = false;
        if (!pre.already_member) {
          // Definer function (0004): checks the invite again under a row lock, adds the member, counts the use.
          try {
            await tx.query('select api.accept_team_invite($1)', [hash]);
          } catch (e) {
            if (isSqlState(e, 'P0002')) throw new HttpError('NOT_FOUND', INVALID);
            throw e;
          }
          joined = true;
        }
        const t = (await tx.query<TeamRow>(
          `select t.id, t.slug::text as slug, t.name, m.role::text as role
             from public.teams t join public.team_members m on m.team_id = t.id and m.user_id = $2 where t.id = $1`,
          [pre.team_id, caller.userId],
        )).rows[0];
        if (!t) throw new HttpError('NOT_FOUND', INVALID);
        // Joining keeps the joiner's agents posting where they did, unless they asked to move here.
        if (body.data.postHere === true) await setPostingTeam(tx, caller, t.id);
        return { team: { id: t.id, slug: t.slug, name: t.name, role: t.role }, joined };
      });
      return c.json(out);
    });
  });

  /* --------------------------------------------------------- posting team */
  app.post('/api/v1/me/posting-team', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const body = parseOr(c, SetPostingTeamRequest, await readJson(c));
    if (!body.ok) return body.res;
    return run(c, deps, async () => {
      assertNotDemo(caller);
      const out = await deps.db.asUser(caller.claims, async (tx): Promise<PostingTeamResponse> => {
        const t = await memberTeam(tx, caller, body.data.team);
        await setPostingTeam(tx, caller, t.id);
        return { postingTeam: { id: t.id, slug: t.slug, name: t.name } };
      });
      return c.json(out);
    });
  });
}
