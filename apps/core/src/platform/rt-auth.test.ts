/**
 * Red-team regressions (auth cluster) on PGlite: pulse/stream key separation and
 * install binding, bounded auth caches, suspended JWT users, provider-gated profile
 * metadata, provision_user on real Supabase Auth, dev/demo login guards, demo
 * session teardown, the seed's system identity, loopback binding and embeddings config.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { createTestDb, type PgliteDb } from '@y/db';
import { ConnectToken } from '@y/schema';
import { fx } from '@y/schema/fixtures';
import type { Hono } from 'hono';
import { createApp, allJobHandlers } from '../app.js';
import type { CoreConfig, CoreDeps } from '../contracts.js';
import { PlatformAuth } from './auth.js';
import { listenHosts } from './config.js';
import { createDeps, loadConfig, migrateCore } from './index.js';
import { defaultSeedDir, loadSeedHighlights } from './seed.js';
import { PULSE_TOKEN_PREFIX, STREAM_TOKEN_PREFIX, hmacHex } from './util.js';

const SUPA = 'https://proj.supabase.test';
const DEMO = 'demo-secret-0123456789abcdef';
const INTERNAL = 'internal-secret-shared-with-mcp';
const quiet: CoreDeps['log'] = () => undefined;
const H = { 'x-demo-secret': DEMO };

let db: PgliteDb;
let jwks: JWTVerifyGetKey;
let sign: (claims: Record<string, unknown>) => Promise<string>;

beforeAll(async () => {
  db = await createTestDb();
  await migrateCore(db);
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }] });
  sign = (claims) =>
    new SignJWT({ role: 'authenticated', amr: [{ method: 'oauth', timestamp: Math.floor(Date.now() / 1000) }], ...claims })
      .setIssuedAt()
      .setAudience('authenticated')
      .setIssuer(`${SUPA}/auth/v1`)
      .setExpirationTime('1h')
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .sign(privateKey);
}, 180_000);
afterAll(async () => {
  await db?.close();
});

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', Y_INTERNAL_SECRET: INTERNAL, Y_HMAC_KEY: 'core-only-hmac-key', PUBLIC_URL: 'http://core.test', Y_DEMO_SECRET: DEMO, SUPABASE_URL: SUPA, ...extra };
}

async function appFor(config: CoreConfig): Promise<{ app: Hono; deps: CoreDeps; f: (r: Request) => Promise<Response> }> {
  const deps = await createDeps(config, db, allJobHandlers(), { scheduleRecurring: false, log: quiet, jwks });
  const app = createApp(deps);
  return { app, deps, f: async (r) => app.fetch(r) };
}

type Res = { status: number; json: Record<string, any> | null };
async function req(f: (r: Request) => Promise<Response>, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
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

/** A real (GitHub-provider) auth user, as Supabase's GitHub OAuth would create it. */
async function githubUser(login: string, githubId: number): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
     values ($1, $2, $3::jsonb, $4::jsonb, now())`,
    [id, `${id}@example.test`, JSON.stringify({ user_name: login, provider_id: String(githubId), full_name: login }), JSON.stringify({ provider: 'github', providers: ['github'] })],
  );
  return id;
}

async function userRow(id: string) {
  return (
    await db.query<{ handle: string; github_login: string | null; github_id: string | null; display_name: string | null; avatar_url: string | null }>(
      'select handle, github_login, github_id::text, display_name, avatar_url from public.users where id = $1',
      [id],
    )
  ).rows[0];
}

/** The user's teams, apart from the default 'dev' team everyone joins (9003) unless `withDev`. */
async function teamSlugs(userId: string, withDev = false): Promise<string[]> {
  return (
    await db.query<{ slug: string }>('select t.slug from public.team_members m join public.teams t on t.id = m.team_id where m.user_id = $1 order by 1', [userId])
  ).rows.map((r) => r.slug).filter((s) => withDev || s !== 'dev');
}

const rnd = (n = 6) => randomBytes(n).toString('hex').slice(0, n);

describe('pulse and stream tokens (#3, #31)', () => {
  let ctx: Awaited<ReturnType<typeof appFor>>;
  let agent: string;
  let pulse: string;
  beforeAll(async () => {
    ctx = await appFor(loadConfig(env()));
    const web = (await req(ctx.f, 'POST', '/api/v1/dev/login', { body: { githubLogin: `pls-${rnd()}` }, headers: H })).json!.token as string;
    agent = ConnectToken.parse((await req(ctx.f, 'POST', '/api/v1/connect/token', { token: web, body: { harness: 'claude_code' } })).json).token;
    pulse = (await req(ctx.f, 'GET', '/api/v1/agent/brief?pluginVersion=0.1.0&harness=claude_code', { token: agent })).json!.pulseToken.token as string;
  }, 60_000);

  it('the brief pulse token works; one signed with the MCP-held internal secret does not', async () => {
    const real = await ctx.deps.auth.verifyBearer(`Bearer ${pulse}`);
    expect(real?.via).toBe('install');
    const body = pulse.slice(PULSE_TOKEN_PREFIX.length, pulse.lastIndexOf('.'));
    const forged = `${PULSE_TOKEN_PREFIX}${body}.${hmacHex(`y-pulse-v1\n${INTERNAL}`, body)}`;
    expect(await ctx.deps.auth.verifyBearer(`Bearer ${forged}`)).toBeNull();
    const sbody = Buffer.from(JSON.stringify({ u: real!.userId, v: 'web', t: Math.floor(Date.now() / 1000), e: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
    const stream = `${STREAM_TOKEN_PREFIX}${sbody}.${hmacHex(`y-stream-v1\n${INTERNAL}`, sbody)}`;
    expect((ctx.deps.auth as PlatformAuth).verifyStreamToken(stream)).toBeNull();
  });

  it('a pulse token must name a live install of that agent and owner', async () => {
    const auth = ctx.deps.auth as PlatformAuth;
    const real = (await auth.verifyBearer(`Bearer ${pulse}`))!;
    const fakeInstall = auth.mintPulseToken({ ...real, installId: randomUUID() }).token;
    expect(await auth.verifyBearer(`Bearer ${fakeInstall}`)).toBeNull();
    const otherAgent = auth.mintPulseToken({ ...real, agentId: randomUUID() }).token;
    expect(await auth.verifyBearer(`Bearer ${otherAgent}`)).toBeNull();
    const otherUser = auth.mintPulseToken({ ...real, userId: randomUUID() }).token;
    expect(await auth.verifyBearer(`Bearer ${otherUser}`)).toBeNull();
  });

  it('revoking the install stops its pulse token on every route, not only /pulse', async () => {
    const chunk = fx.ingestChunk({ sessionId: `pls-${rnd()}`, seq: 0 });
    expect((await req(ctx.f, 'POST', '/api/v1/ingest', { token: pulse, body: chunk })).status).toBe(200);
    const caller = (await ctx.deps.auth.verifyBearer(`Bearer ${pulse}`))!;
    await db.query('update public.installs set revoked_at = now() where id = $1', [caller.installId]);
    (ctx.deps.auth as PlatformAuth).invalidate();
    expect(await ctx.deps.auth.verifyBearer(`Bearer ${pulse}`)).toBeNull();
    const r = await req(ctx.f, 'POST', '/api/v1/ingest', { token: pulse, body: fx.ingestChunk({ sessionId: `pls-${rnd()}`, seq: 0 }) });
    expect(r.status).toBe(401);
  }, 60_000);
});

describe('auth caches are bounded (#32)', () => {
  it('random tokens cannot grow the install or web caches past the cap', async () => {
    const auth = new PlatformAuth(loadConfig(env()), db, () => new Date(), { cacheMax: 20 });
    const b62 = () => Array.from(randomBytes(32), (x) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[x % 62]).join('');
    for (let i = 0; i < 60; i++) {
      expect(await auth.verifyBearer(`Bearer pcl_agt_${b62()}`)).toBeNull();
      expect(await auth.verifyBearer(`Bearer pcl_web_${b62()}`)).toBeNull();
    }
    const sizes = auth.cacheSizes();
    expect(sizes.install).toBeLessThanOrEqual(20);
    expect(sizes.web).toBeLessThanOrEqual(20);
  }, 60_000);
});

describe('Supabase JWT users (#30, #10, #69)', () => {
  let ctx: Awaited<ReturnType<typeof appFor>>;
  beforeAll(async () => {
    ctx = await appFor(loadConfig(env()));
  }, 60_000);

  it('a suspended or deleted user is refused with a valid access token', async () => {
    const sub = await githubUser(`susp-${rnd()}`, 7_000_000 + Math.floor(Math.random() * 1e6));
    const token = await sign({ sub, user_metadata: { user_name: 'whatever' }, app_metadata: { provider: 'github' } });
    expect((await req(ctx.f, 'GET', '/api/v1/me', { token })).status).toBe(200);
    await db.query(`update public.users set status = 'suspended' where id = $1`, [sub]);
    // A fresh instance (no warm cache) sees the status at once.
    const cold = await appFor(loadConfig(env()));
    expect((await req(cold.f, 'GET', '/api/v1/me', { token })).status).toBe(401);
    expect((await req(cold.f, 'POST', '/api/v1/connect/token', { token, body: { harness: 'claude_code' } })).status).toBe(401);
    expect((await req(cold.f, 'POST', '/api/v1/stream-token', { token })).status).toBe(401);
    await db.query(`update public.users set status = 'active' where id = $1`, [sub]);
    const warm = await appFor(loadConfig(env()));
    expect((await req(warm.f, 'GET', '/api/v1/me', { token })).status).toBe(200);
  }, 60_000);

  it('email sign-ups do not get a GitHub login, handle or avatar from their own metadata', async () => {
    const login = `octo-${rnd()}`;
    const id = randomUUID();
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data, email_confirmed_at) values ($1, $2, $3::jsonb, $4::jsonb, now())`,
      [id, `${id}@example.test`, JSON.stringify({ user_name: login, full_name: 'Famous Person', avatar_url: 'https://avatars.test/famous.png' }), JSON.stringify({ provider: 'email', providers: ['email'] })],
    );
    const row = (await userRow(id))!;
    expect(row.github_login).toBeNull();
    expect(row.handle).toMatch(/^user-[0-9a-f]{8}$/);
    expect(row.avatar_url).toBeNull();
    expect(row.display_name).toBeNull();
    // The real GitHub user then gets the bare handle.
    const real = await githubUser(login, 8_000_000 + Math.floor(Math.random() * 1e6));
    expect((await userRow(real))!).toMatchObject({ handle: login, github_login: login });
    // Same rule through a JWT: an email-provider token gets no GitHub identity.
    const sub = randomUUID();
    const token = await sign({ sub, user_metadata: { user_name: `jwt-${login}` }, app_metadata: { provider: 'email', providers: ['email'] } });
    const me = await req(ctx.f, 'GET', '/api/v1/me', { token });
    expect(me.status).toBe(200);
    expect(me.json!.user.handle).toMatch(/^@user-[0-9a-f]{8}$/);
    expect((await userRow(sub))!.github_login).toBeNull();
  }, 60_000);

  it('provision_user never takes github_id from JWT user_metadata', async () => {
    const sub = randomUUID();
    const token = await sign({ sub, user_metadata: { user_name: `prov-${rnd()}`, provider_id: '1024025' }, app_metadata: { provider: 'github', providers: ['github'] } });
    expect((await req(ctx.f, 'GET', '/api/v1/me', { token })).status).toBe(200);
    expect((await userRow(sub))!.github_id).toBeNull();
  }, 60_000);

  it('on real Supabase Auth (auth.identities exists) a token cannot recreate a missing auth user', async () => {
    await db.query('create table if not exists auth.identities (id uuid primary key)');
    try {
      const sub = randomUUID();
      const token = await sign({ sub, user_metadata: { user_name: `ghost-${rnd()}` }, app_metadata: { provider: 'github' } });
      const fresh = await appFor(loadConfig(env()));
      expect((await req(fresh.f, 'GET', '/api/v1/me', { token })).status).toBe(401);
      expect((await db.query('select 1 from auth.users where id = $1', [sub])).rows).toHaveLength(0);
      expect((await db.query('select 1 from public.users where id = $1', [sub])).rows).toHaveLength(0);
      // A live auth user without public.users (created before the migrations) is still provisioned.
      const live = await githubUser(`live-${rnd()}`, 9_000_000 + Math.floor(Math.random() * 1e6));
      await db.query('delete from public.users where id = $1', [live]);
      const t2 = await sign({ sub: live, user_metadata: { user_name: `live2-${rnd()}` }, app_metadata: { provider: 'github' } });
      expect((await req(fresh.f, 'GET', '/api/v1/me', { token: t2 })).status).toBe(200);
    } finally {
      await db.query('drop table if exists auth.identities');
    }
  }, 60_000);
});

describe('dev and demo login guards (#4, #42, #43, #44)', () => {
  let ctx: Awaited<ReturnType<typeof appFor>>;
  const login = async (githubLogin: string, team?: string | null) =>
    req(ctx.f, 'POST', '/api/v1/dev/login', { body: { githubLogin, ...(team !== undefined ? { team } : {}) }, headers: H });
  beforeAll(async () => {
    ctx = await appFor(loadConfig(env()));
  }, 60_000);

  it('dev login cannot join a real user\'s team; /dev/team cannot add real users or change their teams', async () => {
    const owner = await githubUser(`owner-${rnd()}`, 6_000_000 + Math.floor(Math.random() * 1e6));
    const realLogin = (await userRow(owner))!.github_login!;
    const slug = `acme-${rnd()}`;
    await db.query(`with t as (insert into public.teams (slug, name, created_by) values ($1, 'Acme', $2) returning id)
                    insert into public.team_members (team_id, user_id, role) select id, $2, 'owner' from t on conflict do nothing`, [slug, owner]);
    const mallory = `mallory-${rnd()}`;
    const r = await login(mallory, slug);
    expect(r.status).toBe(409);
    expect(r.json!.error.code).toBe('CONFLICT');
    const malloryId = (await db.query<{ id: string }>('select id from public.users where github_login = $1', [mallory])).rows[0]!.id;
    expect(await teamSlugs(malloryId)).not.toContain(slug);
    expect(await teamSlugs(owner)).toEqual([slug]);

    const m = await login(`mallory-${rnd()}`, null);
    expect(m.status).toBe(200);
    const evil = await req(ctx.f, 'POST', '/api/v1/dev/team', { token: m.json!.token, body: { slug: `evil-${rnd()}`, members: [realLogin] }, headers: H });
    expect(evil.status).toBe(404);
    expect(await teamSlugs(owner)).toEqual([slug]);
    const takeover = await req(ctx.f, 'POST', '/api/v1/dev/team', { token: m.json!.token, body: { slug, members: [] }, headers: H });
    expect(takeover.status).toBe(409);
    expect(await teamSlugs(m.json!.user.id)).toEqual([]);
  }, 60_000);

  it('dev teams still work: create on first use, rejoin with more dev users, /dev/team, the default dev team', async () => {
    const slug = `devco-${rnd()}`;
    const a = await login(`ann-${rnd()}`, slug);
    const b = await login(`ben-${rnd()}`, slug);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await teamSlugs(b.json!.user.id)).toEqual([slug]);
    const cLogin = `cat-${rnd()}`;
    const c = await login(cLogin, null);
    const t = await req(ctx.f, 'POST', '/api/v1/dev/team', { token: a.json!.token, body: { slug, members: [cLogin] }, headers: H });
    expect(t.status).toBe(200);
    expect(t.json!.members).toBe(2);
    expect(await teamSlugs(c.json!.user.id)).toEqual([slug]);
    const d = await login(`dan-${rnd()}`);
    expect(d.status).toBe(200);
    expect(await teamSlugs(d.json!.user.id, true)).toContain('dev');
  }, 60_000);

  it('dev login never reuses a real account whose github_id is null', async () => {
    const ghId = 5_000_000 + Math.floor(Math.random() * 1e6);
    await githubUser(`first-${rnd()}`, ghId);
    // Same provider_id: the trigger leaves github_id null on the second account, which is still real.
    const victimLogin = `emma-${rnd()}`;
    const victim = await githubUser(victimLogin, ghId);
    expect((await userRow(victim))!.github_id).toBeNull();
    const r = await login(victimLogin.toUpperCase());
    expect(r.status).toBe(409);
    // A returning dev user still gets their own account back.
    const me = `back-${rnd()}`;
    const first = await login(me);
    expect((await login(me)).json!.user.id).toBe(first.json!.user.id);
  }, 60_000);

  it('a dev squatter loses the login once the real GitHub user signs in; /dev/demo picks the real account', async () => {
    const cto = `futurecto-${rnd()}`;
    const squat = await login(cto);
    expect(squat.status).toBe(200);
    const real = await githubUser(cto, 4_000_000 + Math.floor(Math.random() * 1e6));
    expect((await login(cto)).status).toBe(409);
    const demo = await appFor(loadConfig(env({ Y_DEMO_ACCOUNT: cto })));
    const d = await req(demo.f, 'POST', '/api/v1/dev/demo', { headers: H });
    expect(d.status).toBe(200);
    expect(d.json!.user.id).toBe(real);
    // Only a dev squatter, no real account: no demo sign-in.
    const only = `onlydev-${rnd()}`;
    await login(only);
    const none = await appFor(loadConfig(env({ Y_DEMO_ACCOUNT: only })));
    expect((await req(none.f, 'POST', '/api/v1/dev/demo', { headers: H })).status).toBe(404);
  }, 60_000);

  it('demo-account sessions end when Y_DEMO_ACCOUNT is unset or changed; dev sessions do not', async () => {
    const owner = `judge-${rnd()}`;
    await githubUser(owner, 3_000_000 + Math.floor(Math.random() * 1e6));
    const on = await appFor(loadConfig(env({ Y_DEMO_ACCOUNT: owner })));
    const d = await req(on.f, 'POST', '/api/v1/dev/demo', { headers: H });
    expect(d.status).toBe(200);
    expect((await req(on.f, 'GET', '/api/v1/me', { token: d.json!.token })).status).toBe(200);
    const dev = await login(`plain-${rnd()}`);
    const off = await appFor(loadConfig(env()));
    expect((await req(off.f, 'GET', '/api/v1/me', { token: d.json!.token })).status).toBe(401);
    expect((await req(off.f, 'GET', '/api/v1/me', { token: dev.json!.token })).status).toBe(200);
    const other = await appFor(loadConfig(env({ Y_DEMO_ACCOUNT: `someone-${rnd()}` })));
    expect((await req(other.f, 'GET', '/api/v1/me', { token: d.json!.token })).status).toBe(401);
    const same = await appFor(loadConfig(env({ Y_DEMO_ACCOUNT: owner.toUpperCase() })));
    expect((await req(same.f, 'GET', '/api/v1/me', { token: d.json!.token })).status).toBe(200);
  }, 60_000);
});

describe('seed system identity (#86)', () => {
  it('a real sign-up cannot take @y-team or @yhq, and the seed never adopts a non-system @y-team', async () => {
    const a = await githubUser('y-team', 2_000_001);
    const b = await githubUser('yhq', 2_000_002);
    expect((await userRow(a))!.handle).not.toBe('y-team');
    expect((await userRow(b))!.handle).not.toBe('yhq');
    // Even if a real user ends up holding the handle, the seed creates its own system user.
    await db.query(`update public.users set handle = 'y-team' where id = $1`, [a]);
    const { deps } = await appFor(loadConfig(env()));
    const res = await loadSeedHighlights(db, deps.embedder, defaultSeedDir());
    expect(res.inserted).toBeGreaterThan(0);
    const owner = (await db.query<{ owner: string; provider: string }>(
      `select ag.owner_user_id as owner, au.raw_app_meta_data ->> 'provider' as provider
         from public.agents ag join auth.users au on au.id = ag.owner_user_id where ag.handle = 'yhq'`,
    )).rows[0]!;
    expect(owner.owner).not.toBe(a);
    expect(owner.provider).toBe('system');
    const again = await loadSeedHighlights(db, deps.embedder, defaultSeedDir());
    expect(again.inserted).toBe(0);
  }, 120_000);
});

describe('config (#21, #79)', () => {
  it('a dev-auth core binds loopback unless HOST says otherwise', () => {
    expect(listenHosts({ devAuth: true, production: false }, {})).toEqual(['127.0.0.1', '::1']);
    expect(listenHosts({ devAuth: true, production: false }, { HOST: '0.0.0.0' })).toEqual(['0.0.0.0']);
    expect(listenHosts({ devAuth: false, production: false }, {})).toBeNull();
    expect(listenHosts({ devAuth: true, production: true }, {})).toBeNull();
    expect(listenHosts(loadConfig({ NODE_ENV: 'test', Y_INTERNAL_SECRET: 'x', Y_HMAC_KEY: 'y' }), {})).toEqual(['127.0.0.1', '::1']);
  });

  it('Y_EMBEDDINGS is case-insensitive and production warns when it falls back to the mock', () => {
    const prod = { NODE_ENV: 'production', Y_INTERNAL_SECRET: 'x'.repeat(32), Y_HMAC_KEY: 'y'.repeat(32), SUPABASE_URL: SUPA };
    expect(loadConfig({ ...prod, Y_EMBEDDINGS: 'Supabase', Y_EMBED_SECRET: 'e'.repeat(32) }).embeddings).toBe('gte');
    expect(loadConfig({ ...prod, Y_EMBEDDINGS: 'GTE', Y_EMBED_SECRET: 'e'.repeat(32) }).embeddings).toBe('gte');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(loadConfig(prod).embeddings).toBe('mock');
      expect(warn.mock.calls.some((c) => /Y_EMBEDDINGS/.test(String(c[0])))).toBe(true);
      warn.mockClear();
      expect(loadConfig({ ...prod, Y_EMBEDDINGS: 'mock' }).embeddings).toBe('mock');
      expect(warn.mock.calls.some((c) => /Y_EMBEDDINGS/.test(String(c[0])))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
