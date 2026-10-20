/**
 * The web's repo bar (9113, routes/teams.ts GET /teams/:slug/repos/status) and
 * ?repo= on Updates and Feed: linked repo names are keyed in core exactly as the
 * plugin keys a clone's git remote, matched to sessions, activities and turn
 * summaries by that key, and only names and counts go out (never the key or the
 * team salt). Full app on PGlite (Y_LLM=mock, Y_EMBEDDINGS=mock), synthetic users.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { computeRepoKey, normalizeGitRemote } from '@y/capture';
import { createTestDb, type PgliteDb } from '@y/db';
import { ConnectToken, FeedPage, TeamReposStatus, UpdatesPage, UpdatesSharing, type IngestChunk } from '@y/schema';
import { fx } from '@y/schema/fixtures';
import { allJobHandlers, createApp } from '../app.js';
import type { CoreDeps } from '../contracts.js';
import { createDeps, loadConfig } from './index.js';
import { canonicalGithubRemote, teamRepoKey } from './repo-keys.js';

let db: PgliteDb;
let deps: CoreDeps;
let app: Hono;

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, any>) : null };
}

async function drainAll() {
  for (let i = 0; i < 50; i++) if ((await deps.jobs.drain(20)) === 0) break;
}

interface Person {
  web: string;
  agent: string;
  userId: string;
}

async function person(login: string, team: string): Promise<Person> {
  const web = (await call('POST', '/api/v1/dev/login', undefined, { githubLogin: login, team })).json!.token as string;
  const agent = ConnectToken.parse((await call('POST', '/api/v1/connect/token', web, { harness: 'claude_code' })).json).token;
  const me = (await call('GET', '/api/v1/me', web)).json!;
  return { web, agent, userId: me.user.id as string };
}

let sessionN = 0;
function chunk(repoKey: string | undefined): IngestChunk {
  const base = fx.ingestChunk({ sessionId: `rs-${process.pid}-${sessionN++}`, seq: 0, errorEpisodes: [], setup: undefined });
  const { repoKey: _k, ...rest } = base;
  return {
    ...rest,
    ...(repoKey ? { repoKey } : {}),
    digest: { text: 'USER: fix it\nTOOL Edit: src/a.ts (+1/−1)\nFINAL: done', sha256: 'a'.repeat(64), redaction: { hitsByRule: {}, dropped: false } },
  };
}

async function ingest(p: Person, ch: IngestChunk): Promise<{ activityId: string }> {
  const r = await call('POST', '/api/v1/ingest', p.agent, ch);
  expect(r.status, r.text).toBe(200);
  return r.json as { activityId: string };
}

const teamId = async (slug: string) => (await db.query<{ id: string }>('select id from public.teams where slug = $1', [slug])).rows[0]!.id;
const saltOf = async (slug: string) =>
  (await db.query<{ s: string }>('select s.repo_key_salt as s from public.team_secrets s join public.teams t on t.id = s.team_id where t.slug = $1', [slug])).rows[0]!.s;
const link = async (slug: string, repo: string) =>
  db.query('insert into public.team_repos (team_id, repo) values ($1, $2)', [await teamId(slug), repo]);

async function status(p: Person, slug = 'rs-acme') {
  const r = await call('GET', `/api/v1/teams/${slug}/repos/status`, p.web);
  expect(r.status, r.text).toBe(200);
  return { body: TeamReposStatus.parse(r.json), text: r.text };
}
const byRepo = (s: TeamReposStatus) => Object.fromEntries(s.repos.map((r) => [r.repo, r]));

async function updates(p: Person, repo?: string) {
  const r = await call('GET', `/api/v1/updates${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, p.web);
  return { status: r.status, page: r.status === 200 ? UpdatesPage.parse(r.json) : null, json: r.json };
}

let alice: Person;
let bob: Person;
let carol: Person;
let acmeSalt: string;
let otherSalt: string;
let aliceWeb: { activityId: string };
let bobWeb: { activityId: string };
let bobApi: { activityId: string };
let carolWeb: { activityId: string };

beforeAll(async () => {
  db = await createTestDb();
  const config = loadConfig({ NODE_ENV: 'test', Y_INTERNAL_SECRET: 'test-internal-secret', Y_HMAC_KEY: 'test-hmac', Y_LLM: 'mock', Y_EMBEDDINGS: 'mock' });
  deps = await createDeps(config, db, allJobHandlers(), { scheduleRecurring: false, migrateCore: true, log: () => undefined });
  app = createApp(deps);
  alice = await person('rs-alice', 'rs-acme');
  bob = await person('rs-bob', 'rs-acme');
  carol = await person('rs-carol', 'rs-other');
  acmeSalt = await saltOf('rs-acme');
  otherSalt = await saltOf('rs-other');
  // Linked with GitHub's casing; the clones below use other spellings of the same remote.
  await link('rs-acme', 'Acme/Web');
  await link('rs-acme', 'acme/api');
  await link('rs-acme', 'acme/docs');
  await link('rs-other', 'acme/web');

  // Keys exactly as the plugin's Stop hook computes them from `git remote get-url origin`.
  aliceWeb = await ingest(alice, chunk(computeRepoKey('git@github.com:acme/web.git', acmeSalt)));
  bobWeb = await ingest(bob, chunk(computeRepoKey('https://github.com/ACME/web', acmeSalt)));
  bobApi = await ingest(bob, chunk(computeRepoKey('ssh://git@github.com/acme/api.git', acmeSalt)));
  // Carol's team linked the same repo; her key uses her team's salt and never counts for rs-acme.
  carolWeb = await ingest(carol, chunk(computeRepoKey('https://github.com/acme/web.git', otherSalt)));
  // A session outside any linked repo.
  await ingest(alice, chunk(computeRepoKey('https://github.com/acme/scratch.git', acmeSalt)));
  await drainAll();
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('repo keys in core match the plugin', () => {
  const salt = 'q'.repeat(10) + 'Z9_-'.repeat(8) + 'a'.repeat(22);
  const forms = [
    'https://github.com/acme/web.git',
    'https://github.com/acme/web',
    'https://github.com/Acme/Web.git/',
    'https://someone@github.com/acme/web.git',
    'git@github.com:acme/web.git',
    'git@github.com:Acme/web',
    'ssh://git@github.com/acme/web.git',
    'ssh://git@github.com:22/acme/web',
  ];

  it('every https / ssh / .git form of a remote normalizes to one value', () => {
    for (const f of forms) expect(normalizeGitRemote(f), f).toBe('github.com/acme/web');
    expect(normalizeGitRemote(canonicalGithubRemote('Acme/Web'))).toBe('github.com/acme/web');
  });

  it('teamRepoKey(owner/repo) equals computeRepoKey for each remote form, under the same salt only', () => {
    const key = teamRepoKey('Acme/Web', salt);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    for (const f of forms) expect(computeRepoKey(f, salt), f).toBe(key);
    // Team salts are hex in the database (team_secrets); the plugin reads the same string from its brief.
    expect(teamRepoKey('acme/web', 'ab'.repeat(32))).toBe(computeRepoKey('git@github.com:acme/web.git', 'ab'.repeat(32)));
    expect(teamRepoKey('acme/web', 'cd'.repeat(32))).not.toBe(teamRepoKey('acme/web', 'ab'.repeat(32)));
    expect(teamRepoKey('acme/api', salt)).not.toBe(key);
    // Repo names with dots keep them (only a trailing .git is the suffix).
    expect(teamRepoKey('acme-co/rocket.js', salt)).toBe(computeRepoKey('git@github.com:acme-co/rocket.js.git', salt));
  });
});

describe('GET /api/v1/teams/:slug/repos/status', () => {
  it('counts agents working in each linked repo and the latest activity, by repo key', async () => {
    const { body, text } = await status(alice);
    expect(body.team.slug).toBe('rs-acme');
    expect(body.repos.map((r) => r.repo)).toEqual(['acme/api', 'acme/docs', 'Acme/Web']);
    const r = byRepo(body);
    expect(r['Acme/Web']!.activeAgents).toBe(2);
    expect(r['acme/api']!.activeAgents).toBe(1);
    expect(r['acme/docs']!.activeAgents).toBe(0);
    expect(r['Acme/Web']!.lastActivityAt).toBeDefined();
    expect(r['acme/api']!.lastActivityAt).toBeDefined();
    expect(r['acme/docs']!.lastActivityAt).toBeUndefined();
    // Bob works in two linked repos and counts once across them; Alice's scratch session is in none.
    expect(body.all.activeAgents).toBe(2);
    expect(body.all.lastActivityAt).toBeDefined();
    // Names and counts only: no repo key, no salt.
    for (const secret of [acmeSalt, teamRepoKey('Acme/Web', acmeSalt)!, teamRepoKey('acme/api', acmeSalt)!]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it("uses each team's own salt: the same repo in another team matches only that team's sessions", async () => {
    const { body } = await status(carol, 'rs-other');
    expect(body.repos).toEqual([expect.objectContaining({ repo: 'acme/web', activeAgents: 1 })]);
    expect(body.viewerRole).toBe('owner'); // dev login created rs-other for her
  });

  it('is for members only, as a human', async () => {
    expect((await call('GET', '/api/v1/teams/rs-acme/repos/status', carol.web)).status).toBe(404);
    expect((await call('GET', '/api/v1/teams/rs-acme/repos/status', alice.agent)).status).toBe(403);
    expect((await call('GET', '/api/v1/teams/rs-acme/repos/status')).status).toBe(401);
    // The definer function refuses non-members and agents even when called directly.
    const acme = await teamId('rs-acme');
    const keys = [teamRepoKey('Acme/Web', acmeSalt)!];
    const direct = (claims: Record<string, unknown>) =>
      db.asUser(claims as never, (tx) => tx.query(`select * from api.team_repo_agents($1::uuid, $2::text[])`, [acme, keys]));
    await expect(direct({ sub: carol.userId, via: 'web' })).rejects.toThrow(/team_repo_agents/);
    expect((await direct({ sub: alice.userId, via: 'web' })).rows.length).toBeGreaterThan(0);
  });

  it("leaves out teammates who stopped sharing their updates, but not the viewer's own agents", async () => {
    expect((await call('PUT', '/api/v1/updates/sharing', bob.web, { shareWithTeam: false })).status).toBe(200);
    try {
      expect(byRepo((await status(alice)).body)['Acme/Web']!.activeAgents).toBe(1);
      expect(byRepo((await status(bob)).body)['Acme/Web']!.activeAgents).toBe(2);
    } finally {
      await call('PUT', '/api/v1/updates/sharing', bob.web, { shareWithTeam: true });
    }
  });

  it('stops counting a session once it ends', async () => {
    const extra = await ingest(alice, chunk(computeRepoKey('https://github.com/acme/docs.git', acmeSalt)));
    expect(byRepo((await status(alice)).body)['acme/docs']!.activeAgents).toBe(1);
    await db.query(
      `update public.sessions set status = 'closed', ended_at = now() where id = (select session_id from public.activities where id = $1)`,
      [extra.activityId.replace(/^a_/, '')],
    );
    expect(byRepo((await status(alice)).body)['acme/docs']!.activeAgents).toBe(0);
  });
});

describe('?repo= on Updates and Feed', () => {
  it('narrows Updates to one linked repo of the posting team', async () => {
    const all = (await updates(alice)).page!;
    const acts = (p: UpdatesPage) => new Set(p.items.map((x) => x.activityId));
    expect([...acts(all)]).toEqual(expect.arrayContaining([aliceWeb.activityId, bobWeb.activityId, bobApi.activityId]));

    const web = (await updates(alice, 'acme/web')).page!;
    expect([...acts(web)].sort()).toEqual([aliceWeb.activityId, bobWeb.activityId].sort());
    const api = (await updates(bob, 'ACME/API')).page!;
    expect([...acts(api)]).toEqual([bobApi.activityId]);
    expect((await updates(alice, 'acme/docs')).page!.items.every((x) => x.activityId !== aliceWeb.activityId)).toBe(true);
    // Carol's own team links acme/web too: she sees her own team's summary only.
    expect([...acts((await updates(carol, 'acme/web')).page!)]).toEqual([carolWeb.activityId]);
  });

  it('refuses a repo the posting team has not linked, and bad names', async () => {
    const r = await updates(alice, 'acme/scratch');
    expect(r.status).toBe(404);
    expect(r.json!.error.code).toBe('NOT_FOUND');
    expect((await updates(alice, 'not a repo')).status).toBe(400);
    expect((await call('GET', '/api/v1/feed?tab=all&repo=acme/scratch', alice.web)).status).toBe(404);
  });

  it('narrows the Feed by the same key', async () => {
    // Publish the captured sessions to the team as the worker would (the mock pipeline leaves them open).
    const ids = [aliceWeb, bobWeb, bobApi].map((a) => a.activityId.replace(/^a_/, ''));
    await db.query(
      `update public.activities set status = 'published', published_at = now(), visibility = 'team', screen_action = 'allow', screen_label = 'clean'
        where id = any($1::text[])`,
      [ids],
    );
    const feed = async (q: string) => {
      const r = await call('GET', `/api/v1/feed?tab=all${q}`, alice.web);
      expect(r.status, r.text).toBe(200);
      return FeedPage.parse(r.json).items.flatMap((it) => (it.type === 'activity' ? [it.activity.id] : []));
    };
    expect(await feed('')).toEqual(expect.arrayContaining([aliceWeb.activityId, bobWeb.activityId, bobApi.activityId]));
    expect(await feed('&repo=acme%2Fapi')).toEqual([bobApi.activityId]);
    expect((await feed('&repo=Acme%2FWeb')).sort()).toEqual([aliceWeb.activityId, bobWeb.activityId].sort());
    expect(await feed('&repo=acme%2Fdocs')).toEqual([]);
  });
});

describe('GET /api/v1/updates/sharing', () => {
  it("returns the viewer's setting without the feed, for humans only", async () => {
    const r = await call('GET', '/api/v1/updates/sharing', alice.web);
    expect(r.status).toBe(200);
    expect(UpdatesSharing.parse(r.json)).toEqual({ shareWithTeam: true, teamPolicyAccepted: false });
    await call('PUT', '/api/v1/updates/sharing', alice.web, { shareWithTeam: false });
    expect((await call('GET', '/api/v1/updates/sharing', alice.web)).json).toEqual({ shareWithTeam: false, teamPolicyAccepted: false });
    await call('PUT', '/api/v1/updates/sharing', alice.web, { shareWithTeam: true });
    expect((await call('GET', '/api/v1/updates/sharing', alice.agent)).status).toBe(403);
    expect((await call('GET', '/api/v1/updates/sharing')).status).toBe(401);
  });
});
