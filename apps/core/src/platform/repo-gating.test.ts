/**
 * Repo gating: agents post to Y only from repos linked to their posting team. The brief hands the
 * plugin the allowed (salted) repo keys, ingest drops chunks from any other repo (older plugins),
 * pulse carries a policy version so listeners refresh, and create_post/post_activity need a session
 * in a linked repo. PGlite, no network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeRepoKey } from '@y/capture';
import { createTestDb, type PgliteDb } from '@y/db';
import { AgentBrief, ConnectToken, IngestResponse } from '@y/schema';
import { fx } from '@y/schema/fixtures';
import type { Hono } from 'hono';
import { createApp, allJobHandlers } from '../app.js';
import type { CoreDeps } from '../contracts.js';
import { createDeps, loadConfig, migrateCore } from './index.js';
import { agentInLinkedRepo, repoGatingOn } from './repo-keys.js';

let db: PgliteDb;
let app: Hono;
let deps: CoreDeps;
const f = (r: Request) => app.fetch(r);

beforeAll(async () => {
  db = await createTestDb();
  await migrateCore(db);
  const config = loadConfig({ NODE_ENV: 'test', Y_INTERNAL_SECRET: 'internal-secret', Y_HMAC_KEY: 'hmac', PUBLIC_URL: 'http://core.test', Y_REPO_GATING: 'on' });
  deps = await createDeps(config, db, allJobHandlers(), { scheduleRecurring: false, log: () => undefined });
  app = createApp(deps);
}, 180_000);
afterAll(async () => {
  await db?.close();
});

async function req(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await f(
    new Request(`http://core.test${path}`, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
  );
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
}

async function person(login: string) {
  const web = (await req('POST', '/api/v1/dev/login', { body: { githubLogin: login } })).json!.token as string;
  const agent = ConnectToken.parse((await req('POST', '/api/v1/connect/token', { token: web, body: { harness: 'claude_code' } })).json).token;
  const brief = async () => AgentBrief.parse((await req('GET', '/api/v1/agent/brief?pluginVersion=0.1.0', { token: agent })).json);
  return { web, agent, brief };
}

const ingest = (agent: string, sessionId: string, repoKey?: string) =>
  req('POST', '/api/v1/ingest', { token: agent, body: fx.ingestChunk({ sessionId, seq: 0, ...(repoKey ? { repoKey } : {}) }) });

describe('repo gating', () => {
  it('is on in production and opt-in elsewhere', () => {
    const base = { Y_INTERNAL_SECRET: 's', Y_HMAC_KEY: 'h', PUBLIC_URL: 'http://core.test' };
    expect(repoGatingOn(loadConfig({ ...base, NODE_ENV: 'test' }))).toBe(false);
    expect(repoGatingOn(loadConfig({ ...base, NODE_ENV: 'test', Y_REPO_GATING: 'on' }))).toBe(true);
    expect(repoGatingOn({})).toBe(false);
  });

  it('the brief lists the linked repo keys, ingest keeps only those sessions, and MCP posting follows', async () => {
    const p = await person('gate-alice');
    // On the shared dev team with no linked repos: nothing is allowed and nothing is stored.
    const before = await p.brief();
    expect(before.policy.allowedRepoKeys).toEqual([]);
    const devSalt = before.policy.repoKeySalt;
    const devKey = devSalt ? computeRepoKey('git@github.com:acme/web.git', devSalt) : undefined;
    const dropped = IngestResponse.parse((await ingest(p.agent, 'gate-s0', devKey)).json);
    expect(dropped).toMatchObject({ accepted: false, dropped: 'repo_not_linked' });

    // A team of her own with its first repo: that repo (any remote form) is allowed.
    const created = await req('POST', '/api/v1/teams', { token: p.web, body: { name: 'Gate Co', repos: ['acme/web'] } });
    expect(created.status).toBe(200);
    const b = await p.brief();
    const salt = b.policy.repoKeySalt!;
    const key = computeRepoKey('https://github.com/Acme/web', salt)!;
    expect(key).toBe(computeRepoKey('git@github.com:acme/web.git', salt));
    expect(b.policy.allowedRepoKeys).toEqual([key]);
    expect(b.policy.policyVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(b.policy.policyVersion).not.toBe(before.policy.policyVersion);

    const kept = IngestResponse.parse((await ingest(p.agent, 'gate-s1', key)).json);
    expect(kept.accepted).toBe(true);
    expect(kept.dropped).toBeUndefined();
    const other = computeRepoKey('git@github.com:acme/secret-side-project.git', salt)!;
    expect((await ingest(p.agent, 'gate-s2', other)).json).toMatchObject({ accepted: false, dropped: 'repo_not_linked' });
    expect((await ingest(p.agent, 'gate-s3')).json).toMatchObject({ accepted: false, dropped: 'repo_not_linked' });
    const sessions = await db.query<{ harness_session_id: string }>(
      `select s.harness_session_id from public.sessions s join public.agents a on a.id = s.agent_id
        join public.users u on u.id = a.owner_user_id where u.github_login = 'gate-alice' order by 1`,
    );
    expect(sessions.rows.map((r) => r.harness_session_id)).toEqual(['gate-s1']);
    const chunks = await db.query(`select 1 from public.activity_chunks c join public.sessions s on s.id = c.session_id where s.harness_session_id in ('gate-s0', 'gate-s2', 'gate-s3')`);
    expect(chunks.rowCount).toBe(0);

    // create_post / post_activity: allowed only while a session in a linked repo is open.
    const ids = await db.query<{ user_id: string; agent_id: string }>(
      `select u.id as user_id, a.id as agent_id from public.users u join public.agents a on a.owner_user_id = u.id where u.github_login = 'gate-alice'`,
    );
    const { user_id, agent_id } = ids.rows[0]!;
    expect(await agentInLinkedRepo(deps, user_id, agent_id)).toBe(true);
    await db.query(`update public.sessions set status = 'closed' where agent_id = $1`, [agent_id]);
    expect(await agentInLinkedRepo(deps, user_id, agent_id)).toBe(false);
  });

  it('pulse carries the policy version, which changes when a repo is linked', async () => {
    const p = await person('gate-bob');
    await req('POST', '/api/v1/teams', { token: p.web, body: { name: 'Pulse Co', repos: ['pulse/one'] } });
    const v1 = (await p.brief()).policy.policyVersion;
    const pulse = () => req('GET', '/api/v1/pulse?wait=0', { token: p.agent, headers: { 'x-y-session': 'gate-pulse-1' } });
    expect((await pulse()).json!.policyVersion).toBe(v1);
    const slug = (await req('GET', '/api/v1/me', { token: p.web })).json!.teams.find((t: { name: string }) => t.name === 'Pulse Co').slug;
    expect((await req('POST', `/api/v1/teams/${slug}/repos`, { token: p.web, body: { repo: 'pulse/two' } })).status).toBe(200);
    const v2 = (await pulse()).json!.policyVersion;
    expect(v2).toMatch(/^[0-9a-f]{16}$/);
    expect(v2).not.toBe(v1);
    expect((await p.brief()).policy.allowedRepoKeys).toHaveLength(2);
  });
});
