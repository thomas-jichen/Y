/** GET /api/v1/usage on PGlite: per-day buckets, totals, prior window, streak and RLS scoping. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createTestDb, type PgliteDb } from '@y/db';
import { ConnectToken, UsageSeries, type ActivityStats } from '@y/schema';
import { fx } from '@y/schema/fixtures';
import type { CoreDeps } from '../contracts.js';
import { createDeps, loadConfig, platformModule } from './index.js';

const NOW = new Date('2026-10-17T15:00:00.000Z');
const at = (daysAgo: number, hour: number) => new Date(Date.UTC(2026, 9, 17 - daysAgo, hour));

let db: PgliteDb;
let deps: CoreDeps;
let app: Hono;
const T: Record<string, string> = {};

async function call(path: string, token?: string) {
  const res = await app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}

async function login(githubLogin: string, team?: null): Promise<string> {
  const r = await app.request('/api/v1/dev/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ githubLogin, ...(team === null ? { team: null } : {}) }),
  });
  const token = ((await r.json()) as { token: string }).token;
  const ct = await app.request('/api/v1/connect/token', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ harness: 'claude_code' }),
  });
  ConnectToken.parse(await ct.json());
  return token;
}

async function addActivity(
  handle: string,
  o: { startedAt: Date; status: string; outcome?: string; stats?: ActivityStats },
): Promise<void> {
  const stats = o.stats ?? fx.stats();
  const published = o.status === 'published';
  await db.query(
    `insert into public.activities
       (agent_id, team_id, visibility, status, screen_action, started_at, ended_at, published_at,
        stats, outcome_status, tokens_total, active_ms, wall_ms, cost_usd, tool_calls)
     select a.id, (select id from public.teams where slug = 'dev'), 'team', $2, 'allow', $3, $3, $4,
            $5::jsonb, $6, $7, $8, $9, $10, $11
       from public.agents a where a.handle = $1`,
    [
      handle,
      o.status,
      o.startedAt,
      published ? o.startedAt : null,
      JSON.stringify(stats),
      o.outcome ?? 'unknown',
      stats.tokens.total,
      stats.activeMs,
      stats.wallMs,
      stats.costUsd,
      Object.values(stats.toolCalls).reduce((a, b) => a + b, 0),
    ],
  );
}

beforeAll(async () => {
  db = await createTestDb();
  const config = loadConfig({ NODE_ENV: 'test', Y_INTERNAL_SECRET: 'test-internal-secret', Y_HMAC_KEY: 'test-hmac' });
  deps = await createDeps(config, db, platformModule.jobs, { scheduleRecurring: false, log: () => undefined, now: () => NOW });
  app = new Hono();
  platformModule.register(app, deps);
  app.onError((err, c) => c.json({ error: { code: 'INTERNAL', message: String(err), retryable: true } }, 500));

  T.alice = await login('alice-dev');
  T.bob = await login('bob-dev');
  T.carol = await login('carol-solo', null);
  // Sign-up joins everyone to 'dev' for now (9003); make carol a stranger with no team.
  await db.query(
    `delete from public.team_members where user_id = (select id from public.users where lower(github_login::text) = 'carol-solo')`,
  );

  const h = 'alice-dev-claude';
  const warmup = fx.stats({
    tokens: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0, subagents: 0, total: 1_000 },
    costUsd: 0.01,
    activeMs: 1_000,
    wallMs: 1_000,
    toolCalls: { Read: 1 },
    mcp: {},
    models: ['claude-sonnet-5-5'],
  });
  await addActivity(h, { startedAt: at(0, 10), status: 'published', outcome: 'green' });
  await addActivity(h, { startedAt: at(0, 11), status: 'archived', stats: warmup });
  await addActivity(h, { startedAt: at(1, 9), status: 'open', outcome: 'partial' });
  await addActivity(h, { startedAt: at(2, 10), status: 'published', outcome: 'shipped' });
  // A gap 3 days ago ends the streak at 3.
  await addActivity(h, { startedAt: at(4, 10), status: 'draft' });
  // Prior 7d window (8..14 days ago).
  await addActivity(h, { startedAt: at(8, 12), status: 'published', outcome: 'green' });
  // Outside both 7d windows, inside 30d.
  await addActivity(h, { startedAt: at(20, 12), status: 'published', outcome: 'green' });
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('GET /api/v1/usage', () => {
  it('buckets the owner’s sessions per UTC day with totals, prior window and streak', async () => {
    const r = await call('/api/v1/usage?agent=alice-dev-claude&range=7d', T.alice);
    expect(r.status).toBe(200);
    const u = UsageSeries.parse(r.json);
    expect(u.agent.handle).toBe('@alice-dev-claude');
    expect(u.range).toBe('7d');
    expect(u.days).toHaveLength(7);
    expect(u.days[0]!.day).toBe(new Date(Date.UTC(2026, 9, 11)).toISOString());
    expect(u.days[6]!.day).toBe('2026-10-17T00:00:00.000Z');

    const today = u.days[6]!;
    // fx.stats: input 18k + cacheWrite 20k + subagents 5k = 43k in, 9k out, 160k cache read (= 212k total); + the 1k warmup.
    expect(today).toMatchObject({ sessions: 2, tokensIn: 44_000, tokensOut: 9_000, cacheRead: 160_000, green: 1, tokensToGreen: 212_000 });
    expect(today.costUsd).toBeCloseTo(0.85, 6);
    expect(today.activeMs).toBe(1_261_000);
    expect(u.days[3]!.sessions).toBe(0); // 3 days ago
    expect(u.days[2]).toMatchObject({ sessions: 1, green: 0, tokensToGreen: 0 }); // 4 days ago, a draft

    expect(u.totals.sessions).toBe(5);
    expect(u.totals.tokens).toBe(4 * 212_000 + 1_000);
    expect(u.totals.greenRate).toBeCloseTo(2 / 5, 6);
    expect(u.totals.cacheShare).toBeCloseTo((4 * 160_000) / u.totals.tokens, 6);
    expect(u.totals.costUsd).toBeCloseTo(4 * 0.84 + 0.01, 6);
    expect(u.prior).toEqual({ tokens: 212_000, sessions: 1, activeMs: 1_260_000, costUsd: 0.84, greenRate: 1 });
    expect(u.streak).toBe(3);

    expect(u.heat.map((d) => d.sessions)).toEqual([0, 0, 1, 0, 1, 1, 2]);
    expect(u.hours).toHaveLength(24);
    expect(u.hours[10]).toBeCloseTo(3 / 5, 6);
    expect(u.hours[9]).toBeCloseTo(1 / 5, 6);
    expect(u.tools).toEqual({ Bash: 60, Edit: 36, Read: 49, 'MCP: y': 8 });
    expect(u.models.opus).toBeCloseTo(848_000 / 849_000, 6);
    expect(u.models.sonnet).toBeCloseTo(1_000 / 849_000, 6);
    expect(u.models.haiku).toBe(0);
    expect(u.model).toBe('claude-opus-5-5');
  });

  it('wider ranges reach further back; @-prefixed handles work', async () => {
    const u = UsageSeries.parse((await call('/api/v1/usage?agent=%40alice-dev-claude&range=30d', T.alice)).json);
    expect(u.days).toHaveLength(30);
    expect(u.totals.sessions).toBe(7);
    expect(u.prior.sessions).toBe(0);
    const def = UsageSeries.parse((await call('/api/v1/usage?agent=alice-dev-claude', T.alice)).json);
    expect(def.range).toBe('30d');
  });

  it('a teammate sees only what RLS shows them (published sessions)', async () => {
    const r = await call('/api/v1/usage?agent=alice-dev-claude&range=7d', T.bob);
    expect(r.status).toBe(200);
    const u = UsageSeries.parse(r.json);
    expect(u.totals.sessions).toBe(2);
    expect(u.totals.greenRate).toBe(1);
    expect(u.prior.sessions).toBe(1);
    expect(u.streak).toBe(1);
  });

  it('a stranger’s agent is NOT_FOUND, and inputs are validated', async () => {
    const r = await call('/api/v1/usage?agent=alice-dev-claude&range=7d', T.carol);
    expect(r.status).toBe(404);
    expect(r.json?.error?.code).toBe('NOT_FOUND');
    // And the other way round.
    expect((await call('/api/v1/usage?agent=carol-solo-claude', T.alice)).status).toBe(404);
    expect((await call('/api/v1/usage?agent=nobody-here', T.alice)).status).toBe(404);
    const bad = await call('/api/v1/usage?agent=alice-dev-claude&range=1y', T.alice);
    expect(bad.status).toBe(400);
    expect(bad.json?.error?.code).toBe('VALIDATION');
    expect((await call('/api/v1/usage', T.alice)).status).toBe(400);
    expect((await call('/api/v1/usage?agent=alice-dev-claude')).status).toBe(401);
  });

  it('accepts max-length (128-char) tool and MCP server keys', async () => {
    T.dave = await login('dave-dev');
    const tool = 'T'.repeat(128);
    const server = 's'.repeat(128);
    await addActivity('dave-dev-claude', {
      startedAt: at(0, 8),
      status: 'published',
      stats: fx.stats({ toolCalls: { [tool]: 3 }, mcp: { [server]: { q: 2 } } }),
    });
    const r = await call('/api/v1/usage?agent=dave-dev-claude&range=7d', T.dave);
    expect(r.status).toBe(200);
    expect(UsageSeries.parse(r.json).tools).toEqual({ [tool]: 3, [`MCP: ${server}`]: 2 });
  });

  it('an agent with no sessions gets zeroed days and no streak', async () => {
    const u = UsageSeries.parse((await call('/api/v1/usage?agent=bob-dev-claude&range=7d', T.bob)).json);
    expect(u.days.every((d) => d.sessions === 0)).toBe(true);
    expect(u.totals).toEqual({ tokens: 0, sessions: 0, activeMs: 0, costUsd: 0, greenRate: 0, cacheShare: 0 });
    expect(u.hours.every((h) => h === 0)).toBe(true);
    expect(u.streak).toBe(0);
    expect(u.model).toBeUndefined();
  });
});
