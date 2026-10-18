/**
 * Production / serverless paths on PGlite: the serverless handler, the jobs
 * tick, Supabase JWT verification (local JWKS + HS256), the demo gate,
 * CORS/Origin, step-up, stream tokens, rate limits, pulse revoke, Realtime
 * REST fan-out and the seed loader. No network: fetch is faked.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createTestDb, type PgliteDb } from '@y/db';
import { AgentBrief, ConnectToken, JobsTickResponse, Me } from '@y/schema';
import { fx } from '@y/schema/fixtures';
import type { Hono } from 'hono';
import { createApp, allJobHandlers } from '../app.js';
import type { CoreConfig, CoreDeps } from '../contracts.js';
import { createServerlessHandler } from '../serverless.js';
import { createDeps, loadConfig, migrateCore } from './index.js';
import { installCommands } from './routes/connect.js';
import { ServerlessPushBus } from './serverless-bus.js';
import { SEND_BUCKET, takeToken } from './rate-limit.js';
import { defaultSeedDir, fit, loadSeedHighlights, seedUlid, shapeSeed } from './seed.js';

const SUPA = 'https://proj.supabase.test';
const WEB = 'https://app.y.test';
const CRON = 'cron-secret-0123456789abcdef';
const DEMO = 'demo-secret-0123456789abcdef';
const quiet: CoreDeps['log'] = () => undefined;

let db: PgliteDb;

beforeAll(async () => {
  db = await createTestDb();
  await migrateCore(db); // serverless never migrates on cold start (`pnpm migrate` does)
}, 180_000);
afterAll(async () => {
  await db?.close();
});

type Res = { status: number; json: Record<string, any> | null; headers: Headers };
async function req(fetcher: (r: Request) => Promise<Response> | Response, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const res = await fetcher(
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
  let json: Record<string, any> | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', Y_INTERNAL_SECRET: 'internal-secret', Y_HMAC_KEY: 'hmac', PUBLIC_URL: 'http://core.test', ...extra };
}

async function appFor(config: CoreConfig, extra: Parameters<typeof createDeps>[3] = {}): Promise<{ app: Hono; deps: CoreDeps }> {
  const deps = await createDeps(config, db, allJobHandlers(), { scheduleRecurring: false, log: quiet, ...extra });
  return { app: createApp(deps), deps };
}

async function devUser(app: Hono, login: string, headers: Record<string, string> = {}) {
  const f = (r: Request) => app.fetch(r);
  const web = (await req(f, 'POST', '/api/v1/dev/login', { body: { githubLogin: login }, headers })).json!.token as string;
  const ct = await req(f, 'POST', '/api/v1/connect/token', { token: web, body: { harness: 'claude_code' } });
  if (ct.status !== 200) throw new Error(`connect/token ${ct.status} ${JSON.stringify(ct.json)}`);
  const agent = ConnectToken.parse(ct.json).token;
  return { web, agent };
}

describe('loadConfig (production + serverless)', () => {
  it('selects serverless on VERCEL or Y_MODE and gates dev auth in production', () => {
    expect(loadConfig(baseEnv({ VERCEL: '1' })).mode).toBe('serverless');
    expect(loadConfig(baseEnv({ Y_MODE: 'serverless' })).mode).toBe('serverless');
    expect(loadConfig(baseEnv()).mode).toBe('server');
    const prod = { NODE_ENV: 'production', Y_INTERNAL_SECRET: 'x'.repeat(32), Y_HMAC_KEY: 'y'.repeat(32), SUPABASE_URL: SUPA };
    expect(loadConfig(prod).devAuth).toBe(false);
    expect(loadConfig({ ...prod, Y_DEMO_SECRET: DEMO }).devAuth).toBe(true);
    expect(() => loadConfig({ ...prod, Y_DEV_AUTH: '1' })).toThrow(/DEMO_SECRET/);
    expect(() => loadConfig({ ...prod, VERCEL: '1' })).toThrow(/Y_CRON_SECRET/);
    expect(loadConfig({ ...prod, Y_WEB_ORIGIN: `${WEB}, http://localhost:5173` }).webOrigins).toEqual([WEB, 'http://localhost:5173']);
    expect(() => loadConfig(baseEnv({ Y_EMBEDDINGS: 'gte' }))).toThrow(/Y_EMBED_SECRET/);
  });
});

describe('serverless handler', () => {
  it('serves the app, drains jobs after ingest, and long-polls by polling', async () => {
    const config = loadConfig(baseEnv({ Y_MODE: 'serverless', Y_CRON_SECRET: CRON }));
    const handler = createServerlessHandler({ db, config, waitUntil: null, log: quiet, serverlessPollMs: 50 });
    const { deps, app } = await handler.ready();
    expect(deps.bus).toBeInstanceOf(ServerlessPushBus);
    expect((await req(handler, 'GET', '/healthz')).json).toEqual({ ok: true, mode: 'serverless' });
    const { agent } = await devUser(app, 'sls-alice');
    const chunk = fx.ingestChunk({ sessionId: 'sls-1', seq: 0, close: { reason: 'session_end' }, statsDelta: fx.stats() });
    const r = await req(handler, 'POST', '/api/v1/ingest', { token: agent, body: chunk });
    expect(r.status).toBe(200);
    // The finalize job ran inside the request (no waitUntil): nothing for that activity is left due.
    const left = await db.asService((tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from public.jobs where topic = 'finalize' and payload->>'activityId' = $1 and state in ('queued', 'running')`, [
        String(r.json!.activityId).slice(2),
      ]),
    );
    expect(left.rows[0]!.n).toBe(0);

    // waitForAgent polls the events table (no LISTEN).
    const agentId = (await db.asService((tx) => tx.query<{ id: string }>(`select id from public.agents where handle = 'sls-alice-claude'`))).rows[0]!.id;
    const t0 = Date.now();
    const empty = await deps.bus.waitForAgent(agentId, null, 120);
    expect(empty.events).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    const waiting = deps.bus.waitForAgent(agentId, empty.cursor, 5_000);
    await deps.bus.publish({ type: 'presence', audienceAgentIds: [agentId], audienceUserIds: [], payload: { agentId } });
    const got = await waiting;
    expect(got.events.map((e) => e.type)).toEqual(['presence']);
  }, 60_000);

  it('uses waitUntil when available', async () => {
    const config = loadConfig(baseEnv({ Y_MODE: 'serverless' }));
    const pending: Promise<unknown>[] = [];
    const handler = createServerlessHandler({ db, config, waitUntil: (p) => pending.push(p), log: quiet });
    const { app } = await handler.ready();
    const { agent } = await devUser(app, 'sls-bob');
    const r = await req(handler, 'POST', '/api/v1/ingest', { token: agent, body: fx.ingestChunk({ sessionId: 'sls-2', seq: 0 }) });
    expect(r.status).toBe(200);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
  }, 60_000);
});

describe('POST /internal/jobs/tick', () => {
  it('needs the cron secret and reports what it drained', async () => {
    const { app } = await appFor(loadConfig(baseEnv({ Y_MODE: 'serverless', Y_CRON_SECRET: CRON })));
    const f = (r: Request) => app.fetch(r);
    expect((await req(f, 'POST', '/internal/jobs/tick', { body: { source: 'pg_cron' } })).status).toBe(401);
    expect((await req(f, 'POST', '/internal/jobs/tick', { token: 'wrong-secret-0123456789', body: { source: 'pg_cron' } })).status).toBe(401);
    expect((await req(f, 'POST', '/internal/jobs/tick', { token: CRON, body: { source: 'nope' } })).status).toBe(400);
    const idle = await req(f, 'POST', '/internal/jobs/tick', { token: CRON, body: { source: 'pg_cron', due: 0 } });
    expect(JobsTickResponse.parse(idle.json)).toMatchObject({ claimed: 0, remaining: 0, mode: 'serverless' });
    const run = await req(f, 'POST', '/internal/jobs/tick', { token: CRON, body: { source: 'manual' } });
    expect(run.status).toBe(200);
    JobsTickResponse.parse(run.json);
    // Without a configured secret the tick is closed.
    const { app: closed } = await appFor(loadConfig(baseEnv()));
    expect((await req((r) => closed.fetch(r), 'POST', '/internal/jobs/tick', { token: CRON, body: { source: 'manual' } })).status).toBe(401);
  }, 60_000);
});

describe('Supabase access tokens', () => {
  let app: Hono;
  let sign: (claims: Record<string, unknown>, opts?: { iss?: string; exp?: string; hs?: boolean }) => Promise<string>;
  const HS = 'hs256-legacy-secret-0123456789abcdef';

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
    const jwks = createLocalJWKSet({ keys: [jwk] });
    const config = loadConfig(baseEnv({ SUPABASE_URL: SUPA, SUPABASE_JWT_SECRET: HS, Y_WEB_ORIGIN: WEB }));
    expect(config.devAuth).toBe(false);
    ({ app } = await appFor(config, { jwks }));
    sign = async (claims, opts = {}) => {
      const j = new SignJWT({ role: 'authenticated', ...claims })
        .setIssuedAt()
        .setAudience('authenticated')
        .setIssuer(opts.iss ?? `${SUPA}/auth/v1`)
        .setExpirationTime(opts.exp ?? '1h');
      return opts.hs
        ? j.setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(HS))
        : j.setProtectedHeader({ alg: 'ES256', kid: 'k1' }).sign(privateKey);
    };
  }, 60_000);

  const f = (r: Request) => app.fetch(r);
  const now = () => Math.floor(Date.now() / 1000);

  it('verifies JWKS tokens and provisions public.users with the GitHub handle', async () => {
    const sub = randomUUID();
    const token = await sign({ sub, user_metadata: { user_name: 'Octo-Cat', avatar_url: 'https://avatars.test/o.png' }, app_metadata: { provider: 'github' }, amr: [{ method: 'oauth', timestamp: now() }] });
    const me = await req(f, 'GET', '/api/v1/me', { token });
    expect(me.status).toBe(200);
    expect(Me.parse(me.json).user.handle).toBe('@octo-cat');
    // Second call: same user, no duplicate provisioning.
    expect((await req(f, 'GET', '/api/v1/me', { token })).status).toBe(200);
  });

  it('accepts the HS256 fallback and rejects bad tokens', async () => {
    const hs = await sign({ sub: randomUUID(), user_metadata: { user_name: 'hs-user' }, amr: [{ method: 'oauth', timestamp: now() }] }, { hs: true });
    expect((await req(f, 'GET', '/api/v1/me', { token: hs })).status).toBe(200);
    expect((await req(f, 'GET', '/api/v1/me', { token: await sign({ sub: randomUUID() }, { iss: 'https://evil.test/auth/v1' }) })).status).toBe(401);
    expect((await req(f, 'GET', '/api/v1/me', { token: await sign({ sub: randomUUID() }, { exp: '-1m' }) })).status).toBe(401);
    expect((await req(f, 'GET', '/api/v1/me', { token: await sign({ sub: randomUUID(), role: 'service_role' }) })).status).toBe(401);
    expect((await req(f, 'GET', '/api/v1/me', { token: await sign({ sub: 'not-a-uuid' }) })).status).toBe(401);
    const forged = (await sign({ sub: randomUUID() })).replace(/\.[^.]+$/, '.AAAA');
    expect((await req(f, 'GET', '/api/v1/me', { token: forged })).status).toBe(401);
    // Dev login is off once Supabase auth is configured.
    expect((await req(f, 'POST', '/api/v1/dev/login', { body: { githubLogin: 'x-dev' } })).status).toBe(404);
  });

  it('step-up: decisions and owner instructions need a login younger than 12 h', async () => {
    const sub = randomUUID();
    const old = await sign({ sub, user_metadata: { user_name: 'old-login' }, amr: [{ method: 'oauth', timestamp: now() - 13 * 3600 }] });
    const fresh = await sign({ sub, user_metadata: { user_name: 'old-login' }, amr: [{ method: 'oauth', timestamp: now() - 60 }] });
    const noAmr = await sign({ sub });
    const rv = `/api/v1/review/rv_${'0'.repeat(26)}/decision`;
    const d1 = await req(f, 'POST', rv, { token: old, body: { decision: 'approve' } });
    expect(d1.status).toBe(401);
    expect(d1.json!.error.code).toBe('STEP_UP_REQUIRED');
    expect((await req(f, 'POST', rv, { token: noAmr, body: { decision: 'approve' } })).json!.error.code).toBe('STEP_UP_REQUIRED');
    expect((await req(f, 'POST', `/api/v1/threads/t_${'0'.repeat(26)}/instruct`, { token: old, body: {} })).json!.error.code).toBe('STEP_UP_REQUIRED');
    // A fresh login reaches the route (which then 404s on the unknown item).
    expect((await req(f, 'POST', rv, { token: fresh, body: { decision: 'approve' } })).status).toBe(404);

    // Remote instructions: turning on needs step-up, turning off does not.
    expect((await req(f, 'POST', '/api/v1/connect/token', { token: fresh, body: { harness: 'claude_code' } })).status).toBe(200);
    const agentId = Me.parse((await req(f, 'GET', '/api/v1/me', { token: fresh })).json).agents[0]!.id;
    const ri = '/api/v1/settings/remote-instructions';
    expect((await req(f, 'PUT', ri, { token: old, body: { agentId, on: true } })).json!.error.code).toBe('STEP_UP_REQUIRED');
    expect((await req(f, 'PUT', ri, { token: fresh, body: { agentId, on: true } })).json).toEqual({ agentId, on: true });
    expect((await req(f, 'GET', `${ri}?agentId=${agentId}`, { token: old })).json).toEqual({ agentId, on: true });
    expect((await req(f, 'PUT', ri, { token: old, body: { agentId, on: false } })).json).toEqual({ agentId, on: false });
    expect((await req(f, 'PUT', ri, { token: fresh, body: { agentId: randomUUID(), on: false } })).status).toBe(404);
  });

  it('CORS for Y_WEB_ORIGIN and the Origin check on mutating web routes', async () => {
    const pre = await f(new Request('http://core.test/api/v1/me', { method: 'OPTIONS', headers: { origin: WEB, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } }));
    expect(pre.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull();
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization');
    const bad = await f(new Request('http://core.test/api/v1/me', { method: 'OPTIONS', headers: { origin: 'https://evil.test', 'access-control-request-method': 'GET' } }));
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const token = await sign({ sub: randomUUID(), user_metadata: { user_name: 'origin-user' }, amr: [{ method: 'oauth', timestamp: now() }] });
    const evil = await req(f, 'POST', '/api/v1/connect/token', { token, body: {}, headers: { origin: 'https://evil.test' } });
    expect(evil.status).toBe(403);
    expect(evil.json!.error.code).toBe('SCOPE_FORBIDDEN');
    expect((await req(f, 'POST', '/api/v1/connect/token', { token, body: {}, headers: { origin: WEB } })).status).toBe(200);
    // Plugin routes are not browser routes: no Origin rule.
    expect((await req(f, 'POST', '/api/v1/ingest', { body: {}, headers: { origin: 'https://evil.test' } })).status).toBe(401);
  });
});

describe('demo login gate', () => {
  it('requires X-Demo-Secret when Y_DEMO_SECRET is set', async () => {
    const { app } = await appFor(loadConfig(baseEnv({ Y_DEMO_SECRET: DEMO, SUPABASE_URL: SUPA })));
    const f = (r: Request) => app.fetch(r);
    expect((await req(f, 'POST', '/api/v1/dev/login', { body: { githubLogin: 'demo-a' } })).status).toBe(401);
    expect((await req(f, 'POST', '/api/v1/dev/login', { body: { githubLogin: 'demo-a' }, headers: { 'x-demo-secret': 'wrong' } })).status).toBe(401);
    const ok = await req(f, 'POST', '/api/v1/dev/login', { body: { githubLogin: 'demo-a' }, headers: { 'x-demo-secret': DEMO } });
    expect(ok.status).toBe(200);
    expect((await req(f, 'GET', '/api/v1/me', { token: ok.json!.token })).status).toBe(200);
  }, 60_000);
});

describe('connect install commands', () => {
  it('gives a runnable command only for the token harness, with the configured URLs', () => {
    const cfg = loadConfig(baseEnv({ Y_MCP_URL: 'https://mcp.y.test/mcp' }));
    const cc = installCommands(cfg, 'claude_code', 'pcl_agt_x');
    expect(cc.claudeCode).toBe(
      'claude plugin install y --marketplace thomas-jichen/Y --config agent_token=pcl_agt_x --config api_url=http://core.test --config mcp_url=https://mcp.y.test/mcp',
    );
    expect(cc.codex).toMatch(/^# This token is for Claude Code/);
    const cx = installCommands(cfg, 'codex', 'pcl_agt_y');
    expect(cx.claudeCode).toMatch(/^# This token is for Codex/);
    expect(cx.claudeCode).not.toContain('pcl_agt_y');
  });
});

describe('realtime channel descriptors', () => {
  it('Me.realtime and AgentBrief.realtime: supabase with a publishable key, else local', async () => {
    const PK = 'sb_publishable_0123456789abcdefABCDEF';
    const { app } = await appFor(loadConfig(baseEnv({ SUPABASE_URL: SUPA, SUPABASE_PUBLISHABLE_KEY: PK, Y_DEMO_SECRET: DEMO })));
    const f = (r: Request) => app.fetch(r);
    const u = await devUser(app, 'rt-alice', { 'x-demo-secret': DEMO });
    const me = Me.parse((await req(f, 'GET', '/api/v1/me', { token: u.web })).json);
    expect(me.realtime).toMatchObject({ provider: 'supabase', url: SUPA, apiKey: PK });
    expect(me.realtime?.topic).toMatch(new RegExp(`^user:${me.user.id}:[a-f0-9]{64}$`));
    const brief = AgentBrief.parse((await req(f, 'GET', '/api/v1/agent/brief?pluginVersion=0.1.0', { token: u.agent })).json);
    expect(brief.realtime).toMatchObject({ provider: 'supabase', url: SUPA, apiKey: PK });
    expect(brief.realtime?.topic).toMatch(new RegExp(`^agent:${brief.agent!.id}:[a-f0-9]{64}$`));

    const local = await appFor(loadConfig(baseEnv()));
    const v = await devUser(local.app, 'rt-bob');
    const me2 = Me.parse((await req((r) => local.app.fetch(r), 'GET', '/api/v1/me', { token: v.web })).json);
    expect(me2.realtime?.provider).toBe('local');
  }, 60_000);
});

describe('stream tokens, rate limits, pulse revoke', () => {
  let app: Hono;
  let deps: CoreDeps;
  let u: { web: string; agent: string };
  const f = (r: Request) => app.fetch(r);

  beforeAll(async () => {
    ({ app, deps } = await appFor(loadConfig(baseEnv())));
    u = await devUser(app, 'limits-alice');
  }, 60_000);

  it('issues a 60 s stream token accepted only by GET /api/v1/stream?token=', async () => {
    const t = await req(f, 'POST', '/api/v1/stream-token', { token: u.web });
    expect(t.status).toBe(200);
    const token = t.json!.token as string;
    expect(token).toMatch(/^pcl_sst_/);
    expect(new Date(t.json!.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    const ac = new AbortController();
    const res = await app.fetch(new Request(`http://core.test/api/v1/stream?token=${encodeURIComponent(token)}`, { signal: ac.signal }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    ac.abort();
    await res.body?.cancel().catch(() => undefined);
    expect((await req(f, 'GET', '/api/v1/stream?token=pcl_sst_bogus.sig')).status).toBe(401);
    expect((await req(f, 'GET', '/api/v1/me', { token })).status).toBe(401); // never a bearer
    expect((await req(f, 'POST', '/api/v1/stream-token', { token: u.agent })).status).toBe(403);
    // Dev sessions are fresh: step-up passes through to the route.
    expect((await req(f, 'POST', `/api/v1/review/rv_${'0'.repeat(26)}/decision`, { token: u.web, body: { decision: 'approve' } })).status).toBe(404);
  });

  it('limits ingest to a burst of 5 per session', async () => {
    const codes: number[] = [];
    for (let seq = 0; seq < 6; seq++) {
      codes.push((await req(f, 'POST', '/api/v1/ingest', { token: u.agent, body: fx.ingestChunk({ sessionId: 'rl-1', seq }) })).status);
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    const last = await req(f, 'POST', '/api/v1/ingest', { token: u.agent, body: fx.ingestChunk({ sessionId: 'rl-1', seq: 9 }) });
    expect(last.json!.error.code).toBe('RATE_LIMITED');
    expect(last.headers.get('retry-after')).toMatch(/^\d+$/);
    // Another session has its own bucket.
    expect((await req(f, 'POST', '/api/v1/ingest', { token: u.agent, body: fx.ingestChunk({ sessionId: 'rl-2', seq: 0 }) })).status).toBe(200);
  }, 60_000);

  it('limits send_message to 30 per hour per agent', async () => {
    const agentId = randomUUID();
    const results: boolean[] = [];
    for (let i = 0; i < 31; i++) results.push((await db.asService((tx) => takeToken(tx, 'send', [agentId], SEND_BUCKET))).allowed);
    expect(results.filter(Boolean)).toHaveLength(30);
    expect(results[30]).toBe(false);
  });

  it('pulse rejects a revoked install even with a valid pulse token', async () => {
    const brief = await req(f, 'GET', '/api/v1/agent/brief?pluginVersion=0.1.0&harness=claude_code', { token: u.agent });
    expect(brief.status).toBe(200);
    const pulse = brief.json!.pulseToken.token as string;
    const path = '/api/v1/pulse?wait=0';
    expect((await req(f, 'GET', path, { token: pulse, headers: { 'x-y-session': 'pulse-s1' } })).status).toBe(200);
    await db.asService((tx) =>
      tx.query(`update public.installs set revoked_at = now() where agent_id = (select id from public.agents where handle = 'limits-alice-claude')`),
    );
    const r = await req(f, 'GET', path, { token: pulse, headers: { 'x-y-session': 'pulse-s1' } });
    expect(r.status).toBe(401);
    expect(r.json!.error.code).toBe('UNAUTHORIZED');
    void deps;
  }, 60_000);
});

describe('Realtime REST fan-out (serverless)', () => {
  it('broadcasts each new event once on the owner topics', async () => {
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
      return new Response('{}', { status: 202 });
    }) as typeof fetch;
    const env = { Y_MODE: 'serverless', SUPABASE_URL: SUPA, SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests', Y_DEV_AUTH: '1' };
    // PGlite's shim defines realtime.send, so 'auto' leaves broadcasting to the DB trigger; force the REST path.
    const auto = await appFor(loadConfig(baseEnv(env)), { fetch: (async () => new Response('{}')) as unknown as typeof fetch });
    expect((auto.deps.bus as ServerlessPushBus).broadcasting).toBe(false);
    const config = loadConfig(baseEnv({ ...env, Y_REALTIME_REST: 'on' }));
    const { deps, app } = await appFor(config, { fetch: fakeFetch });
    const bus = deps.bus as ServerlessPushBus;
    expect(bus.broadcasting).toBe(true);
    const { web } = await devUser(app, 'rt-alice');
    const userId = (await req((r) => app.fetch(r), 'GET', '/api/v1/me', { token: web })).json!.user.id as string;
    await bus.flushRealtime(); // drain anything older
    calls.length = 0;
    await bus.publish({ type: 'review.new', audienceAgentIds: [], audienceUserIds: [userId], payload: { reviewId: `rv_${'1'.repeat(26)}` } });
    expect(await bus.flushRealtime()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${SUPA}/realtime/v1/api/broadcast`);
    expect(calls[0]!.headers.apikey).toBe('service-role-key-for-tests');
    const msg = calls[0]!.body.messages[0];
    expect(msg.topic).toMatch(new RegExp(`^user:${userId}:[a-f0-9]{64}$`));
    expect(msg.event).toBe('review.new');
    expect(msg.private).toBe(false);
    expect(msg.payload).toMatchObject({ type: 'review.new', payload: { reviewId: `rv_${'1'.repeat(26)}` } });
    expect(await bus.flushRealtime()).toBe(0); // at most once
  }, 60_000);
});

describe('seed loader', () => {
  it('fits text at sentence/word boundaries and has stable ids', () => {
    expect(fit('One two three. Four five six.', 20)).toBe('One two three.');
    expect(fit('alpha beta gamma delta', 12)).toBe('alpha beta…');
    expect(fit('short', 90)).toBe('short');
    expect(seedUlid('a')).toBe(seedUlid('a'));
    expect(seedUlid('a')).not.toBe(seedUlid('b'));
    expect(seedUlid('a')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(shapeSeed({ kind: 'nope', title: 'x' }).ok).toBe(false);
  });

  it('loads seeds/highlights as public, active, screened, embedded highlights, idempotently', async () => {
    const { deps } = await appFor(loadConfig(baseEnv()));
    const first = await loadSeedHighlights(db, deps.embedder, defaultSeedDir());
    // Seeds that L0 flags are not loaded (a failed screen never raises trust, I8).
    for (const s of first.skipped) expect(s.reason).toMatch(/^screen: /);
    expect(first.inserted).toBeGreaterThanOrEqual(15);
    expect(first.inserted + first.skipped.length).toBe(21);
    const second = await loadSeedHighlights(db, deps.embedder, defaultSeedDir());
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(first.inserted);
    const rows = await db.asAnon((tx) =>
      tx.query<{ n: number; emb: number }>(
        `select count(*)::int as n, count(embedding)::int as emb from public.highlights h
           join public.agents a on a.id = h.author_agent_id
          where a.handle = 'yhq' and h.status = 'active' and h.visibility = 'public' and h.screen_action in ('allow', 'label')`,
      ),
    );
    expect(rows.rows[0]).toEqual({ n: first.inserted, emb: first.inserted });
  }, 120_000);
});
