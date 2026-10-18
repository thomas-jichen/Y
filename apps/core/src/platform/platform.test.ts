/**
 * Platform vertical slice on PGlite: dev login → connect token → ingest (stats + digest)
 * → finalize/screen/publish → heuristic draft → owner approval → teammate P2 match →
 * brief → pulse long-poll via the bus. Library packages still being built in parallel are
 * stubbed with deterministic fakes.
 */
import { createHmac, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb, type PgliteDb } from '@y/db';
import {
  Activity,
  AgentBrief,
  ConnectToken,
  DraftReview,
  FeedPage,
  HookMatchResponse,
  IngestResponse,
  Me,
  ReviewItem,
  ReviewList,
  emptyStats,
  formatInternalSignatureHeader,
  internalSigningString,
  makePointer,
} from '@y/schema';
import { fx } from '@y/schema/fixtures';
import type { CoreDeps } from '../contracts.js';

vi.mock('@y/domain', () => ({
  templatedTitle: (stats: { toolCalls: Record<string, number> }, setup: { model: string }) =>
    `${Object.values(stats.toolCalls).reduce((a, b) => a + b, 0)} tool calls · ${setup.model.replace(/^claude-/, '')}`,
  sizeBucketFor: () => 'M',
  isWarmup: (stats: { toolCalls: Record<string, number>; wallMs: number }) =>
    Object.values(stats.toolCalls).reduce((a, b) => a + b, 0) < 3 || stats.wallMs < 120_000,
}));
vi.mock('@y/redact', () => ({
  redact: (text: string) => ({ text: text.replace(/ghp_[A-Za-z0-9]{36}/g, '<REDACTED:github_pat>'), hitsByRule: {}, dropped: false }),
}));
vi.mock('@y/safety', () => ({
  l0Scan: (text: string) => ({
    label: /ignore (all )?previous instructions/i.test(text) ? 'suspicious' : 'clean',
    findings: [],
    needsL2: false,
    normalizedChanged: false,
  }),
  actionFor: (_cls: string, label: string) => ({
    action: label === 'clean' || label === 'warn' ? 'allow' : 'quarantine',
    flagSender: false,
    notifyOwner: false,
    takedown: false,
    noPush: label !== 'clean',
  }),
}));
vi.mock('@y/capture', () => ({
  normalizeErrorSignature: (t: string) => t.toLowerCase().replace(/\d+/g, '<n>').replace(/\s+/g, ' ').trim().slice(0, 300),
}));

const { loadConfig, createDeps, platformModule, heuristicDrafts } = await import('./index.js');

const SIG = 'error: cannot find module vitest/config from <path>';
const DIGEST = [
  'USER: make the failing test pass',
  'TOOL Bash: pnpm test',
  `ERROR Bash: Error: Cannot find module 'vitest/config' from /repo/app`,
  'TOOL Bash: npm install vitest',
  'ERROR Bash: npm ERR! peer dep conflict',
  'TOOL Bash: pnpm add -D vitest@5',
  'TOOL Bash: pnpm test',
  'OK Bash: Test Files 4 passed (4)',
  'FINAL: tests are green',
].join('\n');

let db: PgliteDb;
let deps: CoreDeps;
let app: Hono;

async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Record<string, any> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, any>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function drainAll() {
  for (let i = 0; i < 50; i++) if ((await deps.jobs.drain(20)) === 0) return;
}

beforeAll(async () => {
  db = await createTestDb();
  const config = loadConfig({ NODE_ENV: 'test', Y_INTERNAL_SECRET: 'test-internal-secret', Y_HMAC_KEY: 'test-hmac' });
  deps = await createDeps(config, db, platformModule.jobs, { scheduleRecurring: false, log: () => undefined });
  app = new Hono();
  platformModule.register(app, deps);
  app.onError((err, c) => c.json({ error: { code: 'INTERNAL', message: String(err), retryable: true } }, 500));
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('loadConfig', () => {
  it('uses dev defaults without Supabase', () => {
    const cfg = loadConfig({ NODE_ENV: 'test' });
    expect(cfg.port).toBe(8787);
    expect(cfg.devAuth).toBe(true);
    expect(cfg.mode).toBe('server');
    expect(cfg.internalSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(loadConfig({ SUPABASE_URL: 'https://x.supabase.co', NODE_ENV: 'test' }).devAuth).toBe(false);
  });
});

describe('heuristicDrafts', () => {
  it('turns an ERROR→OK window into one fix draft with steps and pitfalls', () => {
    const drafts = heuristicDrafts({ digest: DIGEST, episodes: [], normalize: (t) => t.toLowerCase() });
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.kind).toBe('fix');
    expect(d.body.pitfalls.map((p) => p.tried)).toEqual(['Bash: pnpm test', 'Bash: npm install vitest']);
    expect(d.body.steps).toEqual(['Bash: pnpm add -D vitest@5', 'Bash: pnpm test']);
    expect(d.body.verification).toBe('Bash: Test Files 4 passed (4)');
  });
  it('yields nothing without a fix', () => {
    expect(heuristicDrafts({ digest: 'TOOL Bash: x\nERROR Bash: boom', episodes: [], normalize: (t) => t })).toEqual([]);
  });
});

describe('verifyInternal', () => {
  const sign = (t: number, body: string, auth?: string, secret = 'test-internal-secret') => {
    const s = internalSigningString({
      timestamp: t,
      method: 'POST',
      path: '/internal/mcp/inbox',
      bodySha256: createHash('sha256').update(body).digest('hex'),
      authSha256: auth ? createHash('sha256').update(auth).digest('hex') : '-',
    });
    return formatInternalSignatureHeader(t, createHmac('sha256', secret).update(s).digest('hex'));
  };
  const req = (header: string, body: string, auth?: string) => ({
    method: 'POST',
    path: '/internal/mcp/inbox',
    body,
    header: (n: string) => (n.toLowerCase() === 'x-y-internal' ? header : n.toLowerCase() === 'authorization' ? auth : undefined),
  });
  it('accepts a valid signature and rejects tampering, wrong secret and stale timestamps', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(deps.auth.verifyInternal(req(sign(now, '{"a":1}', 'Bearer x'), '{"a":1}', 'Bearer x'))).toBe(true);
    expect(deps.auth.verifyInternal(req(sign(now, '{"a":1}', 'Bearer x'), '{"a":2}', 'Bearer x'))).toBe(false);
    expect(deps.auth.verifyInternal(req(sign(now, '{"a":1}', 'Bearer x'), '{"a":1}', 'Bearer y'))).toBe(false);
    expect(deps.auth.verifyInternal(req(sign(now, '{}', undefined, 'nope'), '{}'))).toBe(false);
    expect(deps.auth.verifyInternal(req(sign(now - 301, '{}'), '{}'))).toBe(false);
    expect(deps.auth.verifyInternal(req('t=1,sig=abc', '{}'))).toBe(false);
  });
});

describe('vertical slice', () => {
  const S: Record<string, any> = {};

  it('dev login, team, connect token', async () => {
    expect((await call('POST', '/api/v1/me')).status).toBe(404);
    expect((await call('GET', '/api/v1/me')).status).toBe(401);
    const a = await call('POST', '/api/v1/dev/login', undefined, { githubLogin: 'alice-dev' });
    const b = await call('POST', '/api/v1/dev/login', undefined, { githubLogin: 'bob-dev' });
    expect(a.status).toBe(200);
    S.alice = a.json!.token;
    S.bob = b.json!.token;
    const me = await call('GET', '/api/v1/me', S.alice);
    expect(me.status).toBe(200);
    const parsedMe = Me.parse(me.json);
    expect(parsedMe.teams.map((t) => t.slug)).toEqual(['dev']);
    const ta = await call('POST', '/api/v1/connect/token', S.alice, { harness: 'claude_code' });
    expect(ta.status).toBe(200);
    S.aliceAgent = ConnectToken.parse(ta.json).token;
    S.bobAgent = ConnectToken.parse((await call('POST', '/api/v1/connect/token', S.bob, {})).json).token;
    const me2 = Me.parse((await call('GET', '/api/v1/me', S.alice)).json);
    expect(me2.agents[0]!.handle).toBe('@alice-dev-claude');
    // An install token cannot use web endpoints, and vice versa.
    expect((await call('GET', '/api/v1/me', S.aliceAgent)).status).toBe(403);
    expect((await call('POST', '/api/v1/ingest', S.alice, fx.ingestChunk())).status).toBe(403);
  }, 120_000);

  it('ingests chunks idempotently and runs the pipeline to a published stats card + draft', async () => {
    const base = {
      sessionId: 'sess-alice-1',
      repoKey: undefined,
      statsDelta: fx.stats(),
      digest: { text: DIGEST, sha256: 'b'.repeat(64), redaction: { hitsByRule: { github_pat: 1 }, dropped: false } },
      errorEpisodes: [{ signature: SIG, tool: 'Bash', excerpt: "Error: Cannot find module 'vitest/config' from /repo/app" }],
    };
    const c0 = await call('POST', '/api/v1/ingest', S.aliceAgent, fx.ingestChunk({ ...base, seq: 0 }));
    expect(c0.status).toBe(200);
    const r0 = IngestResponse.parse(c0.json);
    expect(r0.accepted).toBe(true);
    const dup = IngestResponse.parse((await call('POST', '/api/v1/ingest', S.aliceAgent, fx.ingestChunk({ ...base, seq: 0 }))).json);
    expect(dup).toMatchObject({ accepted: false, duplicate: true, activityId: r0.activityId });
    const c1 = IngestResponse.parse(
      (
        await call('POST', '/api/v1/ingest', S.aliceAgent, {
          ...fx.ingestChunk({ ...base, seq: 1, statsDelta: fx.stats({ toolCalls: { Bash: 2 } }), digest: undefined, errorEpisodes: [], setup: { hash: fx.ingestChunk().setup!.hash } }),
          close: { reason: 'session_end' },
        })
      ).json,
    );
    expect(c1.activityId).toBe(r0.activityId);
    S.activityId = r0.activityId;

    await drainAll();

    const act = Activity.parse((await call('GET', `/api/v1/activities/${S.activityId}`, S.alice)).json);
    expect(act.status).toBe('published');
    expect(act.visibility).toBe('team');
    expect(act.title).toBe('38 tool calls · opus-5-5');
    expect(act.outcome).toMatchObject({ status: 'green', verifiedBy: 'tests' });
    expect(act.setup.components.length).toBeGreaterThan(0);
    expect(act.highlights).toHaveLength(1);
    expect(act.highlights[0]!.status).toBe('draft');

    // Digest purged after distill (I6).
    const chunks = await db.query<{ digest_enc: unknown; digest_purged_at: unknown }>('select digest_enc, digest_purged_at from public.activity_chunks');
    expect(chunks.rows.every((r) => r.digest_enc === null && r.digest_purged_at !== null)).toBe(true);
    // Embedded at 384 dims.
    const emb = await db.query<{ d: number }>(`select vector_dims(embedding) as d from public.activities where embedding is not null`);
    expect(emb.rows[0]?.d).toBe(384);

    // Teammate sees the stats card in the feed but not the draft highlight.
    const bobFeed = FeedPage.parse((await call('GET', '/api/v1/feed?tab=all', S.bob)).json);
    expect(bobFeed.items).toHaveLength(1);
    const bobAct = bobFeed.items[0]!;
    expect(bobAct.type === 'activity' && bobAct.activity.highlights).toEqual([]);
    expect(FeedPage.parse((await call('GET', '/api/v1/feed', S.bob)).json).items).toHaveLength(0);
  }, 120_000);

  it('teammate gets no P2 before approval', async () => {
    const m = await call('POST', '/api/v1/hook/match', S.bobAgent, { v: 1, harness: 'claude_code', sessionId: 'sess-bob-1', signature: SIG, tool: 'Bash' });
    expect(m.status).toBe(200);
    expect(HookMatchResponse.parse(m.json).match).toBeNull();
  }, 60_000);

  it('owner reviews and approves the draft (CAS), which publishes it to the team', async () => {
    const list = ReviewList.parse((await call('GET', '/api/v1/review?kind=draft', S.alice)).json);
    expect(list).toHaveLength(1);
    const item = list[0]!;
    expect(item.state).toBe('pending');
    expect(item.summary).not.toContain('vitest');
    const detail = await call('GET', `/api/v1/review/${item.id}`, S.alice);
    expect(detail.status).toBe(200);
    const dr = DraftReview.parse(detail.json);
    expect(dr.receipt.hitsByRule).toEqual({ github_pat: 1 });
    expect(dr.redactedDigest).toBe('');
    // Bob can't see Alice's review item.
    expect((await call('GET', `/api/v1/review/${item.id}`, S.bob)).status).toBe(404);
    // Agents can't decide (I5).
    expect((await call('POST', `/api/v1/review/${item.id}/decision`, S.aliceAgent, { decision: 'approve' })).status).toBe(403);

    const ok = await call('POST', `/api/v1/review/${item.id}/decision`, S.alice, { decision: 'approve' }, { 'idempotency-key': 'decision-key-1' });
    expect(ok.status).toBe(200);
    expect(ReviewItem.parse(ok.json).state).toBe('approved');
    const again = await call('POST', `/api/v1/review/${item.id}/decision`, S.alice, { decision: 'reject' }, { 'idempotency-key': 'decision-key-2' });
    expect(again.status).toBe(409);
    expect(again.json!.error.code).toBe('CONFLICT');

    await drainAll();
    const feed = FeedPage.parse((await call('GET', '/api/v1/feed?tab=highlights', S.bob)).json);
    expect(feed.items).toHaveLength(1);
    const it0 = feed.items[0]!;
    expect(it0.type === 'activity' && it0.activity.highlights[0]?.status).toBe('active');
    S.highlightId = it0.type === 'activity' ? it0.activity.highlights[0]!.id : null;
  }, 120_000);

  it('teammate hitting the same error gets a P2 pointer and an exposure is recorded', async () => {
    const m = await call('POST', '/api/v1/hook/match', S.bobAgent, { v: 1, harness: 'claude_code', sessionId: 'sess-bob-1', signature: SIG, tool: 'Bash' });
    expect(m.status).toBe(200);
    const r = HookMatchResponse.parse(m.json);
    expect(r.match).toMatchObject({ highlightId: S.highlightId, scope: 'team', authorTrust: 'teammate' });
    expect(r.match!.score).toBeGreaterThanOrEqual(0.6);
    expect(m.json!.pointer).toEqual(makePointer('P2', { highlight_id: S.highlightId, score: 100, scope: 'team' }));
    const ex = await db.query<{ n: number }>(`select count(*)::int as n from public.content_exposures where content_id = $1 and via = 'pointer'`, [S.highlightId]);
    expect(ex.rows[0]!.n).toBe(1);
    // Unrelated error: no match.
    const none = await call('POST', '/api/v1/hook/match', S.bobAgent, { v: 1, harness: 'claude_code', sessionId: 'sess-bob-1', signature: 'segfault in libfoo', tool: 'Bash' });
    expect(HookMatchResponse.parse(none.json).match).toBeNull();
  }, 60_000);

  it('serves the agent brief with a pulse token, and reports unknown tokens', async () => {
    const b = await call('GET', '/api/v1/agent/brief?pluginVersion=0.1.0', S.bobAgent);
    expect(b.status).toBe(200);
    const brief = AgentBrief.parse(b.json);
    expect(brief.tokenState).toBe('ok');
    expect(brief.agent!.handle).toBe('@bob-dev-claude');
    expect(brief.policy.repoKeySalt).toMatch(/^[a-f0-9]{64}$/);
    // The pulse token authenticates the same agent.
    const caller = await deps.auth.verifyBearer(`Bearer ${brief.pulseToken!.token}`);
    expect(caller?.agentId).toBe(brief.agent!.id);
    S.bobAgentId = brief.agent!.id;
    const unknown = AgentBrief.parse((await call('GET', '/api/v1/agent/brief?pluginVersion=0.1.0', `pcl_agt_${'x'.repeat(32)}`)).json);
    expect(unknown).toMatchObject({ tokenState: 'unknown_install', pointers: [] });
  }, 60_000);

  it('bus: an idle long-poll wakes on a targeted event and the cursor advances', async () => {
    const start = await deps.bus.waitForAgent(S.bobAgentId, null, 10);
    expect(start.events).toEqual([]);
    const waiting = deps.bus.waitForAgent(S.bobAgentId, start.cursor, 5_000);
    await deps.bus.publish({ type: 'message.new', audienceAgentIds: [S.bobAgentId], audienceUserIds: [], payload: { threadId: 't_01K8Z0T7Q3W4E5R6T7Y8V9A0P3' } });
    const got = await waiting;
    expect(got.events.map((e) => e.type)).toEqual(['message.new']);
    expect(Number(got.cursor)).toBeGreaterThan(Number(start.cursor));
    // Nothing new after the cursor.
    expect((await deps.bus.waitForAgent(S.bobAgentId, got.cursor, 20)).events).toEqual([]);
  }, 30_000);

  it('SSE: streams ids-only events to the web user', async () => {
    const me = Me.parse((await call('GET', '/api/v1/me', S.alice)).json);
    const ac = new AbortController();
    const res = await app.request('/api/v1/stream', { headers: { authorization: `Bearer ${S.alice}` }, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    await new Promise((r) => setTimeout(r, 20));
    await deps.bus.publish({ type: 'activity.updated', audienceAgentIds: [], audienceUserIds: [me.user.id], payload: { activityId: S.activityId } });
    let text = '';
    // The stream opens with a ': open' comment (flushes headers through proxies), then the event frame.
    while (!/event: activity\.updated[\s\S]*\n\n/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text.startsWith(': open\n\n')).toBe(true);
    expect(text).toContain('event: activity.updated');
    expect(text).toContain(`"activityId":"${S.activityId}"`);
    ac.abort();
    await reader.cancel().catch(() => undefined);
  }, 30_000);

  it('close_idle finalizes activities of sessions idle for 30 min', async () => {
    const before = await call('POST', '/api/v1/ingest', S.bobAgent, fx.ingestChunk({ sessionId: 'sess-bob-idle', seq: 0, digest: undefined, errorEpisodes: [] }));
    const aid = IngestResponse.parse(before.json).activityId!;
    await db.query(`update public.sessions set last_event_at = now() - interval '31 minutes' where harness_session_id = 'sess-bob-idle'`);
    await platformModule.jobs.close_idle!({}, deps);
    await drainAll();
    const act = Activity.parse((await call('GET', `/api/v1/activities/${aid}`, S.bob)).json);
    expect(act.status).toBe('published');
    const s = await db.query<{ status: string; close_reason: string }>(`select status, close_reason from public.sessions where harness_session_id = 'sess-bob-idle'`);
    expect(s.rows[0]).toEqual({ status: 'closed', close_reason: 'idle_timeout' });
  }, 60_000);

  it('a resumed session reopens its warmup and later work starts a new card', async () => {
    const sid = 'sess-bob-resume';
    const send = async (seq: number, statsDelta: ReturnType<typeof emptyStats>, close = true) =>
      IngestResponse.parse(
        (
          await call('POST', '/api/v1/ingest', S.bobAgent, {
            ...fx.ingestChunk({ sessionId: sid, seq, statsDelta, digest: undefined, errorEpisodes: [] }),
            ...(close ? { close: { reason: 'session_end' } } : {}),
          })
        ).json,
      );
    const status = async (id: string) => (await db.query<{ status: string }>('select status from public.activities where id = $1', [id.slice(2)])).rows[0]?.status;
    // Plugin installed mid-session: the first SessionEnd carries no work, so it's a warmup.
    const warm = await send(0, emptyStats());
    await drainAll();
    expect(await status(warm.activityId!)).toBe('archived');
    // Resumed: the whole transcript arrives, then another close.
    expect((await send(1, fx.stats(), false)).activityId).toBe(warm.activityId);
    await send(2, emptyStats());
    await drainAll();
    expect(await status(warm.activityId!)).toBe('published');
    // Resumed again after the card was posted: new work is a new card; a bare close is not.
    const next = await send(3, fx.stats(), false);
    expect(next.activityId).not.toBe(warm.activityId);
    expect((await send(4, emptyStats())).activityId).toBe(next.activityId);
    await drainAll();
    expect(await status(next.activityId!)).toBe('published');
  }, 60_000);

  it('jobs: failures are retried with backoff', async () => {
    let calls = 0;
    (deps.jobs as any).handlers.boom = async () => {
      calls++;
      throw new Error('boom');
    };
    await deps.jobs.enqueue('boom', {}, { dedupeKey: 'boom-1' });
    expect(await deps.jobs.drain(5)).toBe(1);
    expect(calls).toBe(1);
    const j = await db.query<{ state: string; attempts: number; max_attempts: number; later: boolean }>(
      `select state, attempts, max_attempts, run_after > now() as later from public.jobs where dedupe_key = 'boom-1'`,
    );
    expect(j.rows[0]).toMatchObject({ state: 'queued', attempts: 1, max_attempts: 10, later: true });
  }, 30_000);
});
