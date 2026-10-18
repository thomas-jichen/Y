/**
 * Serverless entry (Vercel Hobby): one lazily built app per warm instance.
 *
 * - DB: `pg` on DATABASE_URL (Y_DB_FLAVOR=supabase). Migrations are NOT
 *   run here: `pnpm --filter @y/core migrate` before deploying.
 * - Jobs: after an ingest, send, decision or Slack request, due jobs are
 *   drained in `waitUntil` after the response: `@vercel/functions` when
 *   installed, else the Vercel runtime's request context (the same hook that
 *   package reads). Without either, non-Slack routes drain before responding
 *   with a small budget; Slack routes never do (Slack's 3 s ack), and the
 *   pg_cron tick (POST /internal/jobs/tick) catches up on the rest.
 * - Push: ServerlessPushBus (events rows + Realtime broadcast; polling long-poll).
 */
import { createDb, type Db } from '@y/db';
import type { Hono } from 'hono';
import { createApp, allJobHandlers } from './app.js';
import type { CoreConfig, CoreDeps } from './contracts.js';
import { createDeps, drainWithBudget, loadConfig, type CreateDepsOptions } from './platform/index.js';

/** Inline drain budget when waitUntil is unavailable (keeps ingest/send latency bounded). */
export const AFTER_DRAIN_BUDGET_MS = 1_500;
/** Drain budget inside waitUntil (after the response). */
export const WAIT_UNTIL_DRAIN_BUDGET_MS = 8_000;

const DRAIN_AFTER = [
  /^\/api\/v1\/ingest$/,
  /^\/internal\/mcp\/send_message$/,
  /^\/api\/v1\/review\/[^/]+\/decision$/,
  /^\/api\/v1\/threads$/,
  /^\/api\/v1\/threads\/[^/]+\/comment$/,
  /^\/api\/v1\/slack\/link$/,
  // Slack: queued replies (slack.event) and button decisions (review.<kind>, slack.review_decided).
  // Only in waitUntil: see NO_INLINE_DRAIN.
  /^\/slack\/events$/,
  /^\/slack\/interactivity$/,
];

/** Paths that must answer fast (Slack acks within 3 s): never drained before the response. */
const NO_INLINE_DRAIN = /^\/slack\//;

const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

/** The Vercel runtime's per-request waitUntil (what @vercel/functions reads), or null off Vercel. */
export function requestContextWaitUntil(): WaitUntil | null {
  try {
    const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: WaitUntil } | undefined } | undefined>)[VERCEL_REQUEST_CONTEXT]?.get?.();
    const w = ctx?.waitUntil;
    return typeof w === 'function' ? (p) => w.call(ctx, p) : null;
  } catch {
    return null;
  }
}

export type WaitUntil = (p: Promise<unknown>) => void;

export interface ServerlessOptions extends CreateDepsOptions {
  env?: NodeJS.ProcessEnv;
  /** Use this database instead of createDb(env) (tests: PGlite). */
  db?: Db;
  config?: CoreConfig;
  /**
   * Schedule work after the response. Default: @vercel/functions waitUntil when installed, else the
   * Vercel request context's, else none (inline drain, skipped for Slack paths). null = never use waitUntil.
   */
  waitUntil?: WaitUntil | null;
  afterDrainBudgetMs?: number;
}

export interface ServerlessHandler {
  (req: Request): Promise<Response>;
  /** Resolves the deps (cold start). */
  ready(): Promise<{ app: Hono; deps: CoreDeps }>;
}

async function loadWaitUntil(): Promise<WaitUntil | null> {
  try {
    // Optional dependency: resolved at runtime only.
    const spec = '@vercel/functions';
    const mod = (await import(spec)) as { waitUntil?: WaitUntil };
    return typeof mod.waitUntil === 'function' ? mod.waitUntil : null;
  } catch {
    return null;
  }
}

export function createServerlessHandler(opts: ServerlessOptions = {}): ServerlessHandler {
  let booting: Promise<{ app: Hono; deps: CoreDeps; waitUntil: WaitUntil | null }> | null = null;
  const boot = () =>
    (booting ??= (async () => {
      const env = opts.env ?? process.env;
      const config = opts.config ?? loadConfig({ ...env, Y_MODE: env.Y_MODE ?? 'serverless' });
      const db = opts.db ?? (await createDb(env));
      const deps = await createDeps(config, db, allJobHandlers(), { scheduleRecurring: false, migrateCore: false, ...opts });
      const waitUntil = opts.waitUntil === undefined ? await loadWaitUntil() : opts.waitUntil;
      return { app: createApp(deps), deps, waitUntil };
    })().catch((e: unknown) => {
      booting = null; // retry the cold start on the next request
      throw e;
    }));

  const handler = (async (req: Request): Promise<Response> => {
    const { app, deps, waitUntil } = await boot();
    const res = await app.fetch(req);
    const path = new URL(req.url).pathname;
    if (req.method === 'POST' && res.status < 400 && DRAIN_AFTER.some((r) => r.test(path))) {
      const run = (budget: number) =>
        drainWithBudget(deps, budget).catch((e: unknown) => deps.log('warn', 'after-request drain failed', { err: String(e) }));
      const later = waitUntil ?? (opts.waitUntil === undefined ? requestContextWaitUntil() : null);
      if (later) later(run(WAIT_UNTIL_DRAIN_BUDGET_MS));
      else if (!NO_INLINE_DRAIN.test(path)) await run(opts.afterDrainBudgetMs ?? AFTER_DRAIN_BUDGET_MS);
      // Slack paths without waitUntil: the pg_cron tick drains within a minute.
    }
    return res;
  }) as ServerlessHandler;
  handler.ready = async () => {
    const { app, deps } = await boot();
    return { app, deps };
  };
  return handler;
}
