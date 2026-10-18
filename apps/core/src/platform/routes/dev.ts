/**
 * Dev-only auth (registered only when config.devAuth): GitHub-login-shaped users
 * without OAuth. A dev user joins the default team 'dev', or `team` (a slug, created on
 * first use), or no team with `team: null` (a stranger, for demos against a remote core). Bootstrap writes
 * (auth.users, team membership, sessions) run as service: there is no user yet.
 */
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { GithubLogin, Slug } from '@y/schema';
import type { CoreDeps } from '../../contracts.js';
import { authenticate } from '../http.js';
import { fail, mintWebToken, parseOr, readJson, sha256Hex } from '../util.js';

const DEV_TEAM = 'dev';

const DevLoginRequest = z.object({ githubLogin: GithubLogin, team: Slug.nullable().optional() });
const DevTeamRequest = z.object({ slug: Slug, name: z.string().min(1).max(80).optional(), members: z.array(GithubLogin).max(50) });

/**
 * The dev user's id, or null when the login belongs to a real account (never reused).
 * Only users dev login created (auth provider 'dev') are reused: a real account with a
 * null github_id (another provider, a github_id collision) is still a real account.
 */
async function ensureUser(deps: CoreDeps, login: string): Promise<string | null> {
  const found = await deps.db.asService((tx) =>
    tx.query<{ id: string; dev: boolean }>(
      'select id, y_private.is_dev_user(id) as dev from public.users where lower(github_login::text) = lower($1)',
      [login],
    ),
  );
  if (found.rows.length > 0) {
    if (found.rows.some((r) => !r.dev)) return null;
    return found.rows[0]!.id;
  }
  const id = randomUUID();
  // auth.users is not writable by the API roles (as on Supabase), so this dev-only
  // bootstrap runs as the database owner. The handle_new_auth_user trigger creates
  // public.users with a handle from user_name.
  await deps.db.query(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
     values ($1, $2, $3::jsonb, $4::jsonb, now())`,
    [id, `${login.toLowerCase()}@dev.y.test`, JSON.stringify({ user_name: login, full_name: login }), JSON.stringify({ provider: 'dev', providers: ['dev'] })],
  );
  return id;
}

/**
 * Join (or create) a team as service. An existing team other than the default 'dev'
 * team is joinable only while it is made of dev users (apart from `createdBy`, the
 * caller): dev routes never join real users' teams. Null = refused.
 */
async function addToTeam(deps: CoreDeps, slug: string, name: string, userIds: string[], createdBy: string): Promise<string | null> {
  return deps.db.asService(async (tx) => {
    let team = (await tx.query<{ id: string }>('select id from public.teams where slug = $1', [slug])).rows[0];
    if (team && slug !== DEV_TEAM) {
      const open = await tx.query<{ ok: boolean }>('select y_private.dev_team_open($1, $2) as ok', [team.id, createdBy]);
      if (!open.rows[0]?.ok) return null;
    }
    if (!team) {
      team = (
        await tx.query<{ id: string }>('insert into public.teams (slug, name, created_by) values ($1, $2, $3) returning id', [slug, name, createdBy])
      ).rows[0]!;
    }
    for (const u of userIds) {
      await tx.query(`insert into public.team_members (team_id, user_id, role) values ($1, $2, 'member') on conflict do nothing`, [team.id, u]);
    }
    return team.id;
  });
}

export function registerDevRoutes(app: Hono, deps: CoreDeps): void {
  if (!deps.config.devAuth) return;

  app.post('/api/v1/dev/login', async (c) => {
    const body = parseOr(c, DevLoginRequest, await readJson(c));
    if (!body.ok) return body.res;
    const userId = await ensureUser(deps, body.data.githubLogin);
    if (!userId) return fail(c, 'CONFLICT', 'that handle belongs to a GitHub account; pick another handle');
    const team = body.data.team === undefined ? DEV_TEAM : body.data.team;
    if (team && !(await addToTeam(deps, team, team === DEV_TEAM ? 'Dev team' : team, [userId], userId))) {
      return fail(c, 'CONFLICT', 'that team belongs to real accounts; dev login cannot join it');
    }
    const token = mintWebToken();
    await deps.db.asService((tx) =>
      tx.query('insert into y_private.web_sessions (token_hash, user_id) values ($1, $2)', [sha256Hex(token), userId]),
    );
    const u = await deps.db.asUser({ sub: userId, via: 'web' }, (tx) =>
      tx.query<{ handle: string }>('select handle from public.users where id = $1', [userId]),
    );
    return c.json({ token, user: { id: userId, handle: `@${u.rows[0]?.handle ?? ''}` } });
  });

  // The hosted demo: one click signs anyone into the configured real account, with full access.
  app.post('/api/v1/dev/demo', async (c) => {
    const login = deps.config.demoAccount;
    if (!login) return fail(c, 'NOT_FOUND', 'no demo account on this server');
    const found = await deps.db.asService((tx) =>
      // Only the real GitHub account: never a dev user (or another provider) squatting its login.
      // Its github_id may be null (provisioned from a JWT, or a github_id collision), so the
      // GitHub auth provider counts too.
      tx.query<{ id: string; handle: string }>(
        `select id, handle from public.users
          where lower(github_login::text) = lower($1)
            and not y_private.is_dev_user(id)
            and (github_id is not null or y_private.is_github_user(id))
          order by (github_id is not null) desc
          limit 1`,
        [login],
      ),
    );
    const user = found.rows[0];
    if (!user) return fail(c, 'NOT_FOUND', 'the demo account has not signed in to Y yet');
    const token = mintWebToken();
    await deps.db.asService((tx) =>
      // Tagged with the demo login: core stops honouring it once Y_DEMO_ACCOUNT changes or is unset.
      tx.query('insert into y_private.web_sessions (token_hash, user_id, demo_account) values ($1, $2, $3)', [sha256Hex(token), user.id, login]),
    );
    return c.json({ token, user: { id: user.id, handle: `@${user.handle}` } });
  });

  app.post('/api/v1/dev/team', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const body = parseOr(c, DevTeamRequest, await readJson(c));
    if (!body.ok) return body.res;
    const ids: string[] = [caller.userId];
    for (const login of body.data.members) {
      const r = await deps.db.asService((tx) =>
        // Dev users only: /dev/team never adds a real account to a team.
        tx.query<{ id: string }>(
          'select id from public.users where lower(github_login::text) = lower($1) and y_private.is_dev_user(id)',
          [login],
        ),
      );
      if (!r.rows[0]) return fail(c, 'NOT_FOUND', `no dev user ${login}; POST /api/v1/dev/login first`);
      ids.push(r.rows[0].id);
    }
    const teamId = await addToTeam(deps, body.data.slug, body.data.name ?? body.data.slug, ids, caller.userId);
    if (!teamId) return fail(c, 'CONFLICT', 'that team belongs to real accounts; dev routes cannot change it');
    return c.json({ team: { id: teamId, slug: body.data.slug }, members: ids.length });
  });
}
