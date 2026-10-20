/**
 * Teams (apps/core/migrations/9110, routes/teams.ts): sign-ups no longer join
 * 'dev'; humans create teams, mint invite links and link GitHub repos; an
 * invite joins only on an explicit accept; agents can do none of it (I11);
 * RLS keeps strangers out (I7). PGlite, synthetic users, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthUser } from '@y/db';
import {
  AcceptInviteResponse,
  CreateInviteResponse,
  InvitePreview,
  StatusOutput,
  TeamDetail,
  TeamInviteList,
  GithubRepoName,
} from '@y/schema';

vi.mock('@y/safety', () => import('../messaging/test-fakes.js').then((m) => m.safety));
vi.mock('@y/domain', () => import('../messaging/test-fakes.js').then((m) => m.domain));
vi.mock('@y/retrieval', () => import('../messaging/test-fakes.js').then((m) => m.retrieval));

import { internalMcpModule } from '../internal-mcp/index.js';
import { agentCaller, callTool, makeEnv, seedPerson, webCaller, type Person, type TestEnv } from '../messaging/test-support.js';
import { migrateCore } from './index.js';
import { registerTeamRoutes, slugFromName } from './routes/teams.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let env: TestEnv;
let alice: Person;
let bob: Person;
let eve: Person;
let A: string;
let B: string;
let E: string;

beforeEach(async () => {
  env = await makeEnv([{ register: (app, deps) => registerTeamRoutes(app, deps), jobs: {} }, internalMcpModule]);
  await migrateCore(env.db);
  alice = await seedPerson(env.db, 'alice');
  bob = await seedPerson(env.db, 'bob');
  eve = await seedPerson(env.db, 'eve');
  A = env.token('alice-web', webCaller(alice));
  B = env.token('bob-web', webCaller(bob));
  E = env.token('eve-web', webCaller(eve));
});
afterEach(async () => {
  await env?.db.close();
});

async function req(method: string, path: string, auth: string | undefined, body?: unknown) {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = auth;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await env.app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

const slugsOf = async (userId: string) =>
  (await env.db.query<{ slug: string }>(
    `select t.slug::text as slug from public.team_members m join public.teams t on t.id = m.team_id where m.user_id = $1 order by 1`, [userId])).rows.map((r) => r.slug);

async function createTeam(auth: string, name: string, slug?: string) {
  const r = await req('POST', '/api/v1/teams', auth, { name, ...(slug ? { slug } : {}) });
  expect(r.status).toBe(200);
  return TeamDetail.parse(r.json);
}

async function mintInvite(auth: string, slug: string, body: unknown = {}) {
  const r = await req('POST', `/api/v1/teams/${slug}/invites`, auth, body);
  expect(r.status).toBe(200);
  return CreateInviteResponse.parse(r.json);
}

describe('sign-ups and the shared dev team (9110)', () => {
  it('a new GitHub or email sign-up joins no team; existing dev members stay', async () => {
    const dev = (await env.db.query<{ id: string }>(`insert into public.teams (slug, name) values ('dev', 'Dev team') returning id`)).rows[0]!.id;
    await env.db.query(`insert into public.team_members (team_id, user_id) values ($1, $2)`, [dev, alice.userId]);
    const gh = await createAuthUser(env.db, { userMetadata: { user_name: 'new-gh', provider_id: '5551234' }, appMetadata: { provider: 'github', providers: ['github'] } });
    const mail = await createAuthUser(env.db, { userMetadata: { user_name: 'new-mail' }, appMetadata: { provider: 'email', providers: ['email'] } });
    expect(await slugsOf(gh)).toEqual([]);
    expect(await slugsOf(mail)).toEqual([]);
    expect(await slugsOf(alice.userId)).toEqual(['dev']);
  });
});

describe('creating a team', () => {
  it('makes the creator its owner, derives a unique slug and opens the team room', async () => {
    const d = await createTeam(A, 'Acme Rockets!');
    expect(d.team.slug).toBe('acme-rockets');
    expect(d.team.name).toBe('Acme Rockets!');
    expect(d.viewerRole).toBe('owner');
    expect(d.members.map((m) => [m.user.id, m.role])).toEqual([[alice.userId, 'owner']]);
    expect(d.repos).toEqual([]);
    const room = await env.db.query(`select 1 from y_private.team_rooms where team_id = $1`, [d.team.id]);
    expect(room.rowCount).toBe(1);

    // The same name again gets a suffixed slug; an explicit taken slug is a conflict.
    const again = await createTeam(B, 'Acme Rockets');
    expect(again.team.slug).toMatch(/^acme-rockets-[0-9a-f]{6}$/);
    const taken = await req('POST', '/api/v1/teams', E, { name: 'Mine', slug: 'acme-rockets' });
    expect(taken.status).toBe(409);
    expect(taken.json.error.code).toBe('CONFLICT');
    // 'dev' is the server's.
    const dev = await req('POST', '/api/v1/teams', E, { name: 'Dev', slug: 'dev' });
    expect(dev.status).toBe(400);
    expect((await createTeam(E, 'dev')).team.slug).toBe('dev-team');
  });

  it('validates input and refuses agents and signed-out callers', async () => {
    expect((await req('POST', '/api/v1/teams', A, { name: '' })).status).toBe(400);
    expect((await req('POST', '/api/v1/teams', A, { name: 'x', slug: 'Bad Slug' })).status).toBe(400);
    expect((await req('POST', '/api/v1/teams', A, { name: 'two\nlines' })).status).toBe(400);
    expect((await req('POST', '/api/v1/teams', undefined, { name: 'Nope' })).status).toBe(401);
    const agent = env.token('alice-agent', agentCaller(alice));
    const r = await req('POST', '/api/v1/teams', agent, { name: 'Agent Co' });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('SCOPE_FORBIDDEN');
    // RLS on its own refuses an agent-context insert too.
    await expect(env.db.asUser(agentCaller(alice).claims, (tx) =>
      tx.query(`insert into public.teams (slug, name, created_by) values ('agent-co', 'Agent Co', $1)`, [alice.userId]))).rejects.toThrow();
    // The demo account cannot create teams.
    const demo = env.token('demo-web', { ...webCaller(alice), demoAccount: 'alice' });
    expect((await req('POST', '/api/v1/teams', demo, { name: 'Demo Co' })).status).toBe(403);
  });

  it('a team is visible only to its members', async () => {
    const d = await createTeam(A, 'Hidden');
    expect((await req('GET', `/api/v1/teams/${d.team.slug}`, A)).status).toBe(200);
    const r = await req('GET', `/api/v1/teams/${d.team.slug}`, E);
    expect(r.status).toBe(404);
    expect((await req('GET', '/api/v1/teams/NOT_A_SLUG', A)).status).toBe(404);
  });
});

describe('invite links', () => {
  it('admins mint, list and revoke; the link previews without joining and joins on accept', async () => {
    const d = await createTeam(A, 'Acme');
    const inv = await mintInvite(A, 'acme', { maxUses: 2 });
    expect(inv.token).toMatch(/^yti_[A-Za-z0-9_-]{43}$/);
    expect(inv.url).toBe(`http://localhost:8787/join/${inv.token}`);
    expect(inv.invite).toMatchObject({ role: 'member', maxUses: 2, uses: 0, state: 'active' });
    // Only the hash is stored.
    const stored = await env.db.query<{ token_hash: string }>(`select token_hash from public.team_invites where team_id = $1`, [d.team.id]);
    expect(stored.rows[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.rows[0]!.token_hash).not.toContain(inv.token);

    // Preview: the team, nothing joined.
    const p = await req('POST', '/api/v1/invites/preview', B, { token: inv.token });
    expect(p.status).toBe(200);
    expect(InvitePreview.parse(p.json)).toMatchObject({ team: { slug: 'acme', name: 'Acme' }, role: 'member', alreadyMember: false });
    expect(await slugsOf(bob.userId)).toEqual([]);

    // Accept joins, once; accepting again does not use the invite up.
    const acc = await req('POST', '/api/v1/invites/accept', B, { token: inv.token });
    expect(acc.status).toBe(200);
    expect(AcceptInviteResponse.parse(acc.json)).toEqual({ team: { id: d.team.id, slug: 'acme', name: 'Acme', role: 'member' }, joined: true });
    expect(await slugsOf(bob.userId)).toEqual(['acme']);
    const twice = await req('POST', '/api/v1/invites/accept', B, { token: inv.token });
    expect(twice.json.joined).toBe(false);
    const list = TeamInviteList.parse((await req('GET', '/api/v1/teams/acme/invites', A)).json);
    expect(list.items[0]).toMatchObject({ id: inv.invite.id, uses: 1, state: 'active' });

    // Bob is in the team room now; members see members.
    const room = (await env.db.query<{ thread_id: string }>(`select thread_id from y_private.team_rooms where team_id = $1`, [d.team.id])).rows[0]!;
    const inRoom = await env.db.query(`select 1 from public.thread_participants where thread_id = $1 and p_kind = 'user' and p_id = $2`, [room.thread_id, bob.userId]);
    expect(inRoom.rowCount).toBe(1);
    const asBob = TeamDetail.parse((await req('GET', '/api/v1/teams/acme', B)).json);
    expect(asBob.viewerRole).toBe('member');
    expect(asBob.members.map((m) => m.role)).toEqual(['owner', 'member']);

    // Members (not admins) cannot see or mint invites.
    expect((await req('GET', '/api/v1/teams/acme/invites', B)).status).toBe(403);
    expect((await req('POST', '/api/v1/teams/acme/invites', B, {})).status).toBe(403);

    // Revoked: preview and accept are 404, and the list says revoked.
    const rv = await req('POST', `/api/v1/teams/acme/invites/${inv.invite.id}/revoke`, A);
    expect(rv.status).toBe(200);
    expect(TeamInviteList.parse(rv.json).items[0]!.state).toBe('revoked');
    expect((await req('POST', '/api/v1/invites/preview', E, { token: inv.token })).status).toBe(404);
    const late = await req('POST', '/api/v1/invites/accept', E, { token: inv.token });
    expect(late.status).toBe(404);
    expect(await slugsOf(eve.userId)).toEqual([]);
  });

  it('used up, expired and unknown links do not join', async () => {
    await createTeam(A, 'Acme');
    const one = await mintInvite(A, 'acme', { maxUses: 1 });
    expect((await req('POST', '/api/v1/invites/accept', B, { token: one.token })).status).toBe(200);
    expect((await req('POST', '/api/v1/invites/accept', E, { token: one.token })).status).toBe(404);
    const old = await mintInvite(A, 'acme');
    await env.db.query(`update public.team_invites set expires_at = now() - interval '1 minute' where id = $1`, [old.invite.id]);
    expect((await req('POST', '/api/v1/invites/accept', E, { token: old.token })).status).toBe(404);
    const unknown = `yti_${'A'.repeat(43)}`;
    expect((await req('POST', '/api/v1/invites/preview', E, { token: unknown })).status).toBe(404);
    expect((await req('POST', '/api/v1/invites/accept', E, { token: 'not-a-token' })).status).toBe(400);
    expect(await slugsOf(eve.userId)).toEqual([]);
    const items = TeamInviteList.parse((await req('GET', '/api/v1/teams/acme/invites', A)).json).items;
    expect(items.map((i) => i.state).sort()).toEqual(['expired', 'used_up']);
  });

  it('agents cannot preview, accept or mint invites; strangers cannot revoke', async () => {
    await createTeam(A, 'Acme');
    const inv = await mintInvite(A, 'acme');
    const agent = env.token('bob-agent', agentCaller(bob));
    expect((await req('POST', '/api/v1/invites/preview', agent, { token: inv.token })).status).toBe(403);
    expect((await req('POST', '/api/v1/invites/accept', agent, { token: inv.token })).status).toBe(403);
    expect((await req('POST', '/api/v1/teams/acme/invites', env.token('alice-agent', agentCaller(alice)), {})).status).toBe(403);
    // Even straight through RLS with agent claims, the accept function refuses.
    await expect(env.db.asUser(agentCaller(bob).claims, (tx) => tx.query('select * from api.preview_team_invite($1)', ['0'.repeat(64)]))).rejects.toThrow(/human/);
    expect((await req('POST', `/api/v1/teams/acme/invites/${inv.invite.id}/revoke`, E)).status).toBe(404);
    expect((await req('DELETE', `/api/v1/teams/acme/invites/${inv.invite.id}`, A)).status).toBe(200);
    // The demo account cannot join through a link.
    const fresh = await mintInvite(A, 'acme');
    const demo = env.token('demo-web', { ...webCaller(eve), demoAccount: 'eve' });
    expect((await req('POST', '/api/v1/invites/accept', demo, { token: fresh.token })).status).toBe(403);
    expect(await slugsOf(eve.userId)).toEqual([]);
  });
});

describe('team repos', () => {
  it('admins link and unlink repos by name; members read; strangers see nothing', async () => {
    await createTeam(A, 'Acme');
    const inv = await mintInvite(A, 'acme');
    await req('POST', '/api/v1/invites/accept', B, { token: inv.token });

    const add = await req('POST', '/api/v1/teams/acme/repos', A, { repo: 'acme-co/rocket.js' });
    expect(add.status).toBe(200);
    const d = TeamDetail.parse(add.json);
    expect(d.repos).toEqual([expect.objectContaining({ repo: 'acme-co/rocket.js', addedBy: expect.objectContaining({ id: alice.userId }) })]);
    // Case-insensitive duplicate: no second row.
    expect(TeamDetail.parse((await req('POST', '/api/v1/teams/acme/repos', A, { repo: 'Acme-Co/Rocket.JS' })).json).repos).toHaveLength(1);
    await req('POST', '/api/v1/teams/acme/repos', A, { repo: 'acme-co/launchpad' });

    // Members read; members cannot add or remove.
    const asBob = TeamDetail.parse((await req('GET', '/api/v1/teams/acme', B)).json);
    expect(asBob.repos.map((r) => r.repo)).toEqual(['acme-co/launchpad', 'acme-co/rocket.js']);
    expect((await req('POST', '/api/v1/teams/acme/repos', B, { repo: 'bob/side' })).status).toBe(403);
    expect((await req('POST', `/api/v1/teams/acme/repos/${asBob.repos[0]!.id}/remove`, B)).status).toBe(403);
    // Strangers: 404, and RLS hides the rows.
    expect((await req('POST', '/api/v1/teams/acme/repos', E, { repo: 'eve/x' })).status).toBe(404);
    const seen = await env.db.asUser(webCaller(eve).claims, (tx) => tx.query('select 1 from public.team_repos'));
    expect(seen.rowCount).toBe(0);
    // RLS refuses a member's direct insert too.
    await expect(env.db.asUser(webCaller(bob).claims, (tx) =>
      tx.query(`insert into public.team_repos (team_id, repo, added_by) values ($1, 'bob/side', $2)`, [d.team.id, bob.userId]))).rejects.toThrow();

    // The team's agents see the repos (names only) in status.
    const st = StatusOutput.parse((await callTool(env, 'status', env.token('bob-agent', agentCaller(bob)), {})).body.output);
    expect(st.team_repos).toEqual([{ team: 'acme', repo: 'acme-co/launchpad' }, { team: 'acme', repo: 'acme-co/rocket.js' }]);
    const est = StatusOutput.parse((await callTool(env, 'status', env.token('eve-agent', agentCaller(eve)), {})).body.output);
    expect(est.team_repos).toBeUndefined();

    // Unlink.
    const del = await req('DELETE', `/api/v1/teams/acme/repos/${asBob.repos[0]!.id}`, A);
    expect(TeamDetail.parse(del.json).repos.map((r) => r.repo)).toEqual(['acme-co/rocket.js']);
    expect((await req('DELETE', `/api/v1/teams/acme/repos/${asBob.repos[0]!.id}`, A)).status).toBe(404);
  });

  it('accepts GitHub names only', async () => {
    await createTeam(A, 'Acme');
    for (const repo of ['nope', '-bad/repo', 'bad-/repo', 'a--b/repo', 'owner/..', 'owner/.', 'owner/repo.git', 'owner/re po', 'https://github.com/a/b', `o/${'r'.repeat(101)}`]) {
      expect((await req('POST', '/api/v1/teams/acme/repos', A, { repo })).status, repo).toBe(400);
    }
    for (const repo of ['a/b', 'octo-cat/Hello_World.v2', `${'o'.repeat(39)}/${'r'.repeat(100)}`]) {
      expect(GithubRepoName.safeParse(repo).success, repo).toBe(true);
      expect((await req('POST', '/api/v1/teams/acme/repos', A, { repo })).status, repo).toBe(200);
    }
  });
});

describe('slugFromName', () => {
  it('lowercases, strips accents and punctuation, and never returns an empty slug', () => {
    expect(slugFromName('Café  Crème — Team')).toBe('cafe-creme-team');
    expect(slugFromName('***')).toBe('team');
    expect(slugFromName('x'.repeat(100))).toHaveLength(60);
  });
});
