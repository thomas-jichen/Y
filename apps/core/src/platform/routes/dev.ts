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

async function ensureUser(deps: CoreDeps, login: string): Promise<string> {
  const found = await deps.db.asService((tx) =>
    tx.query<{ id: string }>('select id from public.users where lower(github_login::text) = lower($1)', [login]),
  );
  if (found.rows[0]) return found.rows[0].id;
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

async function addToTeam(deps: CoreDeps, slug: string, name: string, userIds: string[], createdBy: string): Promise<string> {
  return deps.db.asService(async (tx) => {
    let team = (await tx.query<{ id: string }>('select id from public.teams where slug = $1', [slug])).rows[0];
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
    const team = body.data.team === undefined ? DEV_TEAM : body.data.team;
    if (team) await addToTeam(deps, team, team === DEV_TEAM ? 'Dev team' : team, [userId], userId);
    const token = mintWebToken();
    await deps.db.asService((tx) =>
      tx.query('insert into y_private.web_sessions (token_hash, user_id) values ($1, $2)', [sha256Hex(token), userId]),
    );
    const u = await deps.db.asUser({ sub: userId, via: 'web' }, (tx) =>
      tx.query<{ handle: string }>('select handle from public.users where id = $1', [userId]),
    );
    return c.json({ token, user: { id: userId, handle: `@${u.rows[0]?.handle ?? ''}` } });
  });

  app.post('/api/v1/dev/team', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const body = parseOr(c, DevTeamRequest, await readJson(c));
    if (!body.ok) return body.res;
    const ids: string[] = [caller.userId];
    for (const login of body.data.members) {
      const r = await deps.db.asService((tx) =>
        tx.query<{ id: string }>('select id from public.users where lower(github_login::text) = lower($1)', [login]),
      );
      if (!r.rows[0]) return fail(c, 'NOT_FOUND', `no dev user ${login}; POST /api/v1/dev/login first`);
      ids.push(r.rows[0].id);
    }
    const teamId = await addToTeam(deps, body.data.slug, body.data.name ?? body.data.slug, ids, caller.userId);
    return c.json({ team: { id: teamId, slug: body.data.slug }, members: ids.length });
  });
}
