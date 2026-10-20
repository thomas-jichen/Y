/**
 * `pnpm --filter @y/core smoke:serverless`: drives the real Vercel entry
 * (api/index.ts, Web-standard handlers) in-process against a migrated, file-backed
 * PGlite, the way Vercel + pg_cron would: dev login (behind the demo secret, as in
 * production), connect token, ingest a closing chunk (finalized inside the request), ingest
 * an open session that then goes idle, POST /internal/jobs/tick with the cron secret (its
 * close_idle + finalize jobs run there), then read the feed. No network. Exits non-zero on failure.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, migrate, type Db } from '@y/db';
import { ConnectToken, FeedPage, JobsTickResponse } from '@y/schema';
import { fx } from '@y/schema/fixtures';
import { migrateCore } from '../src/platform/index.js';

const dir = mkdtempSync(join(tmpdir(), 'y-sls-'));
const CRON = 'smoke-cron-secret-0123456789';
const DEMO = 'smoke-demo-secret-0123456789';
/** Env vars that could aim the in-process entry at a real database or service. */
const SCRUBBED_ENV = [
  'DATABASE_URL',
  'DATABASE_LISTEN_URL',
  'Y_DB_FLAVOR',
  'Y_DB_LOCAL',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
  'SUPABASE_JWKS_URL',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_TEAM_ID',
  'ANTHROPIC_API_KEY',
  'GROQ_API_KEY',
  'Y_SUMMARY_LLM',
  'AI_GATEWAY_API_KEY',
  'Y_EMBED_URL',
  'Y_EMBED_SECRET',
  'Y_REALTIME_REST',
] as const;
const steps: string[] = [];
const ok = (s: string) => {
  steps.push(s);
  console.log(`ok  ${s}`);
};
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

try {
  // 1. `pnpm migrate` equivalent (serverless never migrates on a cold start).
  const pre = await createDb({ Y_DATA_DIR: dir });
  await migrate(pre);
  await migrateCore(pre);
  await pre.close();
  ok(`migrated a file-backed PGlite at ${dir}`);

  // 2. Production-shaped serverless env, then load the Vercel entry. The entry builds its db
  // from process.env, so an exported DATABASE_URL (DEPLOY.md has operators export the prod
  // pooler URL) would win over Y_DATA_DIR and point this smoke at production. Drop every
  // database and external-service variable first: the smoke only ever talks to the PGlite.
  for (const k of SCRUBBED_ENV) delete process.env[k];
  Object.assign(process.env, {
    NODE_ENV: 'production',
    VERCEL: '1',
    Y_DATA_DIR: dir,
    PUBLIC_URL: 'https://core.smoke.test',
    Y_INTERNAL_SECRET: 'smoke-internal-secret-0123456789',
    Y_HMAC_KEY: 'smoke-hmac-key-0123456789',
    Y_CRON_SECRET: CRON,
    Y_DEMO_SECRET: DEMO,
    Y_WEB_ORIGIN: 'https://web.smoke.test',
    Y_LLM: 'mock',
    Y_EMBEDDINGS: 'mock',
  });
  const entry = (await import('../src/vercel-entry.js')) as Record<string, (r: Request) => Promise<Response>>;
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) check(typeof entry[m] === 'function', `src/vercel-entry.ts does not export ${m}`);
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await entry[method]!(
      new Request(`https://core.smoke.test${path}`, {
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
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  };

  const health = await call('GET', '/healthz');
  check(health.status === 200 && health.json?.mode === 'serverless', `healthz: ${JSON.stringify(health)}`);
  ok('GET /healthz → serverless');

  const noSecret = await call('POST', '/api/v1/dev/login', { body: { githubLogin: 'smoke-ana' } });
  check(noSecret.status === 401, `dev login without X-Demo-Secret should be 401, got ${noSecret.status}`);
  const login = await call('POST', '/api/v1/dev/login', { body: { githubLogin: 'smoke-ana' }, headers: { 'x-demo-secret': DEMO } });
  check(login.status === 200, `dev login: ${JSON.stringify(login)}`);
  ok('dev login is gated by X-Demo-Secret in production');

  const ct = await call('POST', '/api/v1/connect/token', { token: login.json.token, body: { harness: 'claude_code' } });
  check(ct.status === 200, `connect token: ${JSON.stringify(ct)}`);
  const agent = ConnectToken.parse(ct.json).token;
  ok('POST /api/v1/connect/token');

  const chunk = fx.ingestChunk({ sessionId: 'smoke-sls-1', seq: 0, close: { reason: 'session_end' }, statsDelta: fx.stats() });
  const ing = await call('POST', '/api/v1/ingest', { token: agent, body: chunk });
  check(ing.status === 200, `ingest: ${JSON.stringify(ing)}`);
  ok(`POST /api/v1/ingest → ${ing.json.activityId} (jobs drained inline: no @vercel/functions)`);

  // A second session that never closes: the request leaves it open; only the cron tick's close_idle can finish it.
  const open = await call('POST', '/api/v1/ingest', { token: agent, body: fx.ingestChunk({ sessionId: 'smoke-sls-2', seq: 0, statsDelta: fx.stats() }) });
  check(open.status === 200, `ingest (open session): ${JSON.stringify(open)}`);
  // The entry's handlers share one lazily built app; reach its db to age the session past the idle cutoff.
  const { deps } = await (entry.POST as unknown as { ready: () => Promise<{ deps: { db: Db } }> }).ready();
  const db = deps.db;
  // Age only the smoke's own session (never "every open session").
  const aged = await db.asService((tx) =>
    tx.query(
      `update public.sessions set last_event_at = now() - interval '31 minutes' where status = 'open' and harness_session_id = $1`,
      ['smoke-sls-2'],
    ),
  );
  check(aged.rowCount === 1, `expected to age exactly the smoke session, aged ${aged.rowCount ?? 0}`);
  ok(`POST /api/v1/ingest → ${open.json.activityId} left open; aged it past the 30 min idle cutoff`);

  // First cron minute: the tick arms the recurring close_idle job (due in 5 min); fast-forward it.
  const arm = await call('POST', '/internal/jobs/tick', { token: CRON, body: { source: 'pg_cron' } });
  check(arm.status === 200, `arming tick: ${JSON.stringify(arm)}`);
  const armed = await db.asService((tx) =>
    tx.query(`update public.jobs set run_after = now() where topic = 'close_idle' and state = 'queued' returning id`),
  );
  check((armed.rowCount ?? 0) >= 1, 'the tick did not arm close_idle');
  ok('first tick armed close_idle (fast-forwarded to due)');

  const badTick = await call('POST', '/internal/jobs/tick', { token: 'wrong-secret-0123456789', body: { source: 'pg_cron' } });
  check(badTick.status === 401, `tick with a wrong secret should be 401, got ${badTick.status}`);
  const tick = await call('POST', '/internal/jobs/tick', { token: CRON, body: { source: 'pg_cron' } });
  check(tick.status === 200, `tick: ${JSON.stringify(tick)}`);
  const t = JobsTickResponse.parse(tick.json);
  check(t.mode === 'serverless' && t.claimed >= 1 && t.failed === 0, `tick ran nothing: ${JSON.stringify(t)}`);
  ok(`POST /internal/jobs/tick → claimed ${t.claimed}, completed ${t.completed}, failed ${t.failed} in ${t.durationMs} ms`);

  const feed = await call('GET', '/api/v1/feed?tab=all', { token: login.json.token });
  check(feed.status === 200, `feed: ${JSON.stringify(feed)}`);
  const page = FeedPage.parse(feed.json);
  const ids = page.items.flatMap((i) => (i.type === 'activity' ? [i.activity.id] : []));
  check(ids.includes(ing.json.activityId), `feed lacks the request-finalized ${ing.json.activityId}`);
  check(ids.includes(open.json.activityId), `feed lacks the tick-finalized ${open.json.activityId}: ${ids.join(', ')}`);
  ok(`GET /api/v1/feed?tab=all shows both activities (one finalized in the request, one by the tick)`);

  const jobs = await db.asService((tx) =>
    tx.query<{ topic: string; state: string; n: number }>(`select topic, state, count(*)::int as n from public.jobs group by 1, 2 order by 1, 2`),
  );
  console.log(`    jobs: ${jobs.rows.map((r) => `${r.topic}=${r.state}×${r.n}`).join(', ')}`);
  const dead = jobs.rows.filter((r) => r.state === 'dead');
  check(dead.length === 0, `dead jobs: ${JSON.stringify(dead)}`);
  await db.close().catch(() => undefined);
  console.log(`serverless smoke: ${steps.length} checks passed`);
} catch (e) {
  console.error(`serverless smoke FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
