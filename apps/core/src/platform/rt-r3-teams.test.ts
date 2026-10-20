/**
 * Red-team round 3 (teams cluster) on PGlite: the default 'dev' team (which
 * sign-ups no longer join since 9110) is created only by the server and the
 * hosted demo's dev login does not own it; demo-account sessions cannot mint
 * durable grants (Slack link, /dev/team); sessions minted before 9101 are
 * tagged; pulse fails soft before 9101 is applied; and the commit-order
 * trigger keeps the ids of a lone multi-event transaction. Synthetic users.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthUser, createTestDb, type PgliteDb } from '@y/db';
import { ConnectToken } from '@y/schema';
import type { Hono } from 'hono';
import { createApp, allJobHandlers } from '../app.js';
import type { CoreConfig, CoreDeps } from '../contracts.js';
import { PlatformAuth } from './auth.js';
import { createDeps, loadConfig, migrateCore } from './index.js';
import { mintWebToken, sha256Hex } from './util.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const DEMO = 'demo-secret-0123456789abcdef';
const H = { 'x-demo-secret': DEMO };
const quiet: CoreDeps['log'] = () => undefined;
const rnd = (n = 6) => randomBytes(n).toString('hex').slice(0, n);

const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  Y_INTERNAL_SECRET: 'internal-secret-shared-with-mcp',
  Y_HMAC_KEY: 'core-only-hmac-key',
  PUBLIC_URL: 'http://core.test',
  ...extra,
});

type Res = { status: number; json: Record<string, any> | null };

async function appFor(db: PgliteDb, config: CoreConfig): Promise<{ deps: CoreDeps; req: (m: string, p: string, o?: { token?: string; body?: unknown; headers?: Record<string, string> }) => Promise<Res> }> {
  const deps = await createDeps(config, db, allJobHandlers(), { scheduleRecurring: false, log: quiet });
  const app: Hono = createApp(deps);
  const req = async (method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await app.fetch(
      new Request(`http://core.test${path}`, {
        method,
        headers: {
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
          ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...o.headers,
        },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      }),
    );
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  return { deps, req };
}

const githubSignUp = (db: PgliteDb, login: string, providerId: string) =>
  createAuthUser(db, { userMetadata: { user_name: login, provider_id: providerId }, appMetadata: { provider: 'github', providers: ['github'] } });

async function memberships(db: PgliteDb, userId: string): Promise<Array<{ slug: string; role: string }>> {
  return (
    await db.query<{ slug: string; role: string }>(
      `select t.slug::text as slug, m.role::text as role from public.team_members m join public.teams t on t.id = m.team_id where m.user_id = $1 order by 1`,
      [userId],
    )
  ).rows;
}
const slugs = async (db: PgliteDb, userId: string) => (await memberships(db, userId)).map((m) => m.slug);

describe('default team: one team for everyone (R0, R5, R26, R28, R32)', () => {
  let db: PgliteDb;
  beforeAll(async () => {
    db = await createTestDb();
    await migrateCore(db);
  });
  afterAll(async () => {
    await db?.close();
  });

  it('local dev: GitHub and email sign-ups no longer join a dev-login dev team (9110); dev login still honours `team`; its creator owns it', async () => {
    const { req } = await appFor(db, loadConfig(baseEnv()));
    const login = async (githubLogin: string, team?: string | null) => {
      const r = await req('POST', '/api/v1/dev/login', { body: { githubLogin, ...(team === undefined ? {} : { team }) } });
      expect(r.status).toBe(200);
      return r.json!.user.id as string;
    };
    const first = await login('local-vivan');
    // Local dev keeps the existing behaviour: the first dev login creates and owns 'dev'.
    expect(await memberships(db, first)).toEqual([{ slug: 'dev', role: 'owner' }]);
    expect(await slugs(db, await login('local-maya'))).toEqual(['dev']);

    // A real GitHub sign-up after a dev login no longer joins (9110: create a team or open an invite link).
    expect(await slugs(db, await githubSignUp(db, 'late-real', '5550101'))).toEqual([]);
    // Other providers don't either, and get no GitHub identity (#10).
    const email = await createAuthUser(db, { userMetadata: { user_name: 'octocat', full_name: 'Octo' }, appMetadata: { provider: 'email', providers: ['email'] } });
    expect(await slugs(db, email)).toEqual([]);
    const row = (await db.query<{ github_login: string | null; github_id: string | null; display_name: string | null }>(
      'select github_login::text, github_id::text, display_name from public.users where id = $1', [email])).rows[0]!;
    expect(row).toEqual({ github_login: null, github_id: null, display_name: null });

    // Dev login places its own users.
    expect(await slugs(db, await login('zed-solo', 'zed-co'))).toEqual(['zed-co']);
    expect(await slugs(db, await login('stranger-x', null))).toEqual([]);
  });

  it('API roles cannot create the default team; other teams still can be created (and owned)', async () => {
    const fresh = await createTestDb();
    try {
      await migrateCore(fresh);
      const u = await githubSignUp(fresh, 'would-be-owner', '5550102');
      const claims = { sub: u, via: 'web' };
      await expect(
        fresh.asUser(claims, (tx) => tx.query('insert into public.teams (slug, name, created_by) values ($1, $2, $3)', ['dev', 'Mine', u])),
      ).rejects.toThrow(/created by the server only/);
      await fresh.asUser(claims, (tx) => tx.query('insert into public.teams (slug, name, created_by) values ($1, $2, $3)', ['my-co', 'My Co', u]));
      expect(await memberships(fresh, u)).toEqual([{ slug: 'my-co', role: 'owner' }]);
      // Service code (dev login) still creates it.
      await fresh.query(`insert into public.teams (slug, name) values ('dev', 'Dev team')`);
    } finally {
      await fresh.close();
    }
  });

  it('hosted door-code demo: dev login creates dev with no owner; GitHub sign-ups no longer join it (9110)', async () => {
    const fresh = await createTestDb();
    try {
      await migrateCore(fresh);
      const { req } = await appFor(fresh, loadConfig(baseEnv({ Y_DEMO_SECRET: DEMO })));
      const judge = (await req('POST', '/api/v1/dev/login', { body: { githubLogin: 'judge-one' }, headers: H })).json!.user.id as string;
      expect(await memberships(fresh, judge)).toEqual([{ slug: 'dev', role: 'member' }]);
      const team = (await fresh.query<{ created_by: string | null }>(`select created_by from public.teams where slug = 'dev'`)).rows[0]!;
      expect(team.created_by).toBeNull();
      const owners = await fresh.query(`select 1 from public.team_members m join public.teams t on t.id = m.team_id where t.slug = 'dev' and m.role in ('owner', 'admin')`);
      expect(owners.rowCount).toBe(0);
      expect(await memberships(fresh, await githubSignUp(fresh, 'real-after-demo', '5550103'))).toEqual([]);
      // A second dev login joins as a member too.
      const two = (await req('POST', '/api/v1/dev/login', { body: { githubLogin: 'judge-two' }, headers: H })).json!.user.id as string;
      expect(await memberships(fresh, two)).toEqual([{ slug: 'dev', role: 'member' }]);
    } finally {
      await fresh.close();
    }
  });
});

describe('demo-account sessions and durable grants (R24, R29, R2, R25)', () => {
  let db: PgliteDb;
  beforeAll(async () => {
    db = await createTestDb();
    await migrateCore(db);
  });
  afterAll(async () => {
    await db?.close();
  });

  const linkToken = async () => {
    const token = `ysl_${randomBytes(32).toString('base64url')}`;
    await db.query(
      `insert into public.slack_link_tokens (token_hash, slack_team_id, slack_user_id, expires_at) values ($1, 'T0DEMO01', $2, now() + interval '10 minutes')`,
      [sha256Hex(token), `U${rnd(8).toUpperCase()}`],
    );
    return token;
  };

  it('a demo session cannot link Slack or change teams; a dev session still can', async () => {
    const owner = `demo-owner-${rnd()}`;
    const ownerId = await githubSignUp(db, owner, String(7_000_000 + Math.floor(Math.random() * 1e6)));
    const { req } = await appFor(db, loadConfig(baseEnv({ Y_DEMO_SECRET: DEMO, Y_DEMO_ACCOUNT: owner })));
    const demo = (await req('POST', '/api/v1/dev/demo', { headers: H })).json!.token as string;

    const token = await linkToken();
    const link = await req('POST', '/api/v1/slack/link', { token: demo, body: { token } });
    expect(link.status).toBe(403);
    expect(link.json!.error.code).toBe('SCOPE_FORBIDDEN');
    expect((await db.query('select 1 from public.slack_identity_links where user_id = $1', [ownerId])).rowCount).toBe(0);
    expect((await db.query('select used_at from public.slack_link_tokens where token_hash = $1', [sha256Hex(token)])).rows[0]).toEqual({ used_at: null });

    const team = await req('POST', '/api/v1/dev/team', { token: demo, body: { slug: `demo-co-${rnd()}`, members: [] }, headers: H });
    expect(team.status).toBe(403);
    expect((await slugs(db, ownerId)).filter((s) => s.startsWith('demo-co-'))).toEqual([]);

    // Non-demo sessions are unchanged.
    const dev = (await req('POST', '/api/v1/dev/login', { body: { githubLogin: `plain-${rnd()}` }, headers: H })).json!.token as string;
    expect((await req('POST', '/api/v1/slack/link', { token: dev, body: { token: await linkToken() } })).status).toBe(200);
    expect((await req('POST', '/api/v1/dev/team', { token: dev, body: { slug: `dev-co-${rnd()}`, members: [] }, headers: H })).status).toBe(200);
  });

  it('9101 tags live web sessions of real GitHub accounts minted before it (they came from /dev/demo)', async () => {
    const owner = `pre-demo-${rnd()}`;
    const ownerId = await githubSignUp(db, owner, String(8_000_000 + Math.floor(Math.random() * 1e6)));
    const { req: devReq } = await appFor(db, loadConfig(baseEnv({ Y_DEMO_SECRET: DEMO })));
    const dev = (await devReq('POST', '/api/v1/dev/login', { body: { githubLogin: `pre-dev-${rnd()}` }, headers: H })).json!.token as string;
    // What /dev/demo wrote before 9101: an untagged session for the real account.
    const old = mintWebToken();
    await db.query('insert into y_private.web_sessions (token_hash, user_id) values ($1, $2)', [sha256Hex(old), ownerId]);

    const sql = await readFile(new URL('../../migrations/9101_rt_auth.sql', import.meta.url), 'utf8');
    const section = sql.slice(sql.indexOf('-- 9. pre-existing demo-account sessions'));
    expect(section).toMatch(/^-- 9\. pre-existing demo-account sessions[\s\S]*update y_private\.web_sessions/);
    await db.query(section);

    const tags = await db.query<{ demo_account: string | null }>('select demo_account from y_private.web_sessions where token_hash = $1', [sha256Hex(old)]);
    expect(tags.rows[0]!.demo_account).toBe(owner);
    const off = await appFor(db, loadConfig(baseEnv({ Y_DEMO_SECRET: DEMO })));
    expect((await off.req('GET', '/api/v1/me', { token: old })).status).toBe(401);
    expect((await off.req('GET', '/api/v1/me', { token: dev })).status).toBe(200);
    const on = await appFor(db, loadConfig(baseEnv({ Y_DEMO_SECRET: DEMO, Y_DEMO_ACCOUNT: owner })));
    expect((await on.req('GET', '/api/v1/me', { token: old })).status).toBe(200);
  });
});

describe('pulse before 9101 is applied (R1)', () => {
  it('a pulse token still resolves when api.pulse_install is missing', async () => {
    const db = await createTestDb();
    try {
      await migrateCore(db);
      const { deps, req } = await appFor(db, loadConfig(baseEnv({ Y_DEMO_SECRET: DEMO, Y_PULSE_V1_UNTIL: 'off' })));
      const web = (await req('POST', '/api/v1/dev/login', { body: { githubLogin: `pls-${rnd()}` }, headers: H })).json!.token as string;
      const agent = ConnectToken.parse((await req('POST', '/api/v1/connect/token', { token: web, body: { harness: 'claude_code' } })).json).token;
      const pulse = (await req('GET', '/api/v1/agent/brief?pluginVersion=0.1.0&harness=claude_code', { token: agent })).json!.pulseToken.token as string;
      await db.query('alter function api.pulse_install(uuid) rename to pulse_install_hidden');
      const auth = new PlatformAuth(deps.config, db, () => new Date());
      const caller = await auth.verifyBearer(`Bearer ${pulse}`);
      expect(caller?.via).toBe('install');
      // The fallback still refuses a revoked install.
      await db.query('update public.installs set revoked_at = now() where id = $1', [caller!.installId]);
      const fresh = new PlatformAuth(deps.config, db, () => new Date());
      expect(await fresh.verifyBearer(`Bearer ${pulse}`)).toBeNull();
      expect(await fresh.verifyBearer(`Bearer ${auth.mintPulseToken({ ...caller!, installId: randomUUID() }).token}`)).toBeNull();
    } finally {
      await db.close();
    }
  });
});

describe('commit-order trigger cost (R4)', () => {
  let db: PgliteDb;
  let userId: string;
  beforeAll(async () => {
    db = await createTestDb();
    await migrateCore(db);
    userId = await githubSignUp(db, 'cursor-r4', '5550199');
  });
  afterAll(async () => {
    await db?.close();
  });

  const insert = (tx: { query: PgliteDb['query'] }, tag: string) =>
    tx.query<{ id: string }>(
      `insert into public.events (type, audience_user_ids, payload) values ('presence', array[$1]::uuid[], $2::jsonb) returning id`,
      [userId, JSON.stringify({ tag })],
    );
  const idsOf = async (prefix: string) =>
    (await db.query<{ id: string; tag: string }>(`select id, payload->>'tag' as tag from public.events where payload->>'tag' like $1 order by id`, [`${prefix}%`])).rows;
  const last = async () => Number((await db.query<{ v: string }>(`select pg_sequence_last_value('public.events_id_seq') as v`)).rows[0]!.v);

  it('a lone transaction with several events keeps every id (no re-draws)', async () => {
    const provisional: number[] = [];
    await db.asService(async (tx) => {
      for (const t of ['lone-1', 'lone-2', 'lone-3']) provisional.push(Number((await insert(tx, t)).rows[0]!.id));
      // A multi-row statement too.
      const multi = await tx.query<{ id: string }>(
        `insert into public.events (type, audience_user_ids, payload)
         select 'presence', array[$1]::uuid[], jsonb_build_object('tag', 'lone-' || g) from generate_series(4, 5) g returning id`,
        [userId],
      );
      provisional.push(...multi.rows.map((r) => Number(r.id)));
    });
    expect((await idsOf('lone-')).map((r) => Number(r.id))).toEqual(provisional);
    expect(await last()).toBe(provisional[provisional.length - 1]);
  });

  it('still re-draws above an id another writer drew in between, keeping order', async () => {
    let between = 0;
    await db.asService(async (tx) => {
      await insert(tx, 'gap-1');
      between = Number((await tx.query<{ v: string }>(`select nextval('public.events_id_seq') as v`)).rows[0]!.v);
      await insert(tx, 'gap-2');
    });
    const rows = await idsOf('gap-');
    expect(rows.map((r) => r.tag)).toEqual(['gap-1', 'gap-2']);
    for (const r of rows) expect(Number(r.id)).toBeGreaterThan(between);
  });

  it('a later write after another writer drew re-draws, even if an earlier batch was kept', async () => {
    let drawn = 0;
    await db.asService(async (tx) => {
      await insert(tx, 'imm-1');
      await tx.query('set constraints all immediate');
      await tx.query('set constraints all deferred');
      drawn = Number((await tx.query<{ v: string }>(`select nextval('public.events_id_seq') as v`)).rows[0]!.v);
      await insert(tx, 'imm-2');
      await tx.query(`select nextval('public.events_id_seq')`);
    });
    const rows = await idsOf('imm-');
    expect(rows.map((r) => r.tag)).toEqual(['imm-1', 'imm-2']);
    expect(Number(rows[0]!.id)).toBeLessThan(drawn);
    expect(Number(rows[1]!.id)).toBeGreaterThan(drawn + 1);
  });

  it('a rolled-back savepoint leaves a gap, so the run is re-drawn', async () => {
    let lostId = 0;
    await db.asService(async (tx) => {
      await insert(tx, 'sp-1');
      await tx.query('savepoint s');
      lostId = Number((await insert(tx, 'sp-lost')).rows[0]!.id);
      await tx.query('rollback to savepoint s');
      await insert(tx, 'sp-2');
    });
    const rows = await idsOf('sp-');
    expect(rows.map((r) => r.tag)).toEqual(['sp-1', 'sp-2']);
    for (const r of rows) expect(Number(r.id)).toBeGreaterThan(lostId);
  });
});
