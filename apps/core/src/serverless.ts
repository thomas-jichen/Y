/**
 * Serverless entry (Vercel Hobby): one lazily built app per warm instance.
 *
 * - DB: `pg` on DATABASE_URL (PACELINE_DB_FLAVOR=supabase). Migrations are NOT
 *   run here: `pnpm --filter @paceline/core migrate` before deploying.
 * - Jobs: after an ingest or send request, due jobs are drained. With
 *   `@vercel/functions` installed the drain runs in `waitUntil` after the
 *   response; otherwise it runs before responding with a small budget. The
 *   pg_cron tick (POST /internal/jobs/tick) catches up on the rest.
 * - Push: ServerlessPushBus (events rows + Realtime broadcast; polling long-poll).
 */
import { createDb, type Db } from '@paceline/db';
import type { Hono } from 'hono';
import { createApp, allJobHandlers } from './app.js';
import type { CoreConfig, CoreDeps } from './contracts.js';
import { createDeps, drainWithBudget, loadConfig, type CreateDepsOptions } from './platform/index.js';

/** Inline drain budget when waitUntil is unavailable (keeps ingest/send latency bounded). */
export const AFTER_DRAIN_BUDGET_MS = 1_500;
/** Drain budget inside waitUntil (after the response). */
export const WAIT_UNTIL_DRAIN_BUDGET_MS = 8_000;

const DRAIN_AFTER = [/^\/api\/v1\/ingest$/, /^\/internal\/mcp\/send_message$/, /^\/api\/v1\/review\/[^/]+\/decision$/];

export type WaitUntil = (p: Promise<unknown>) => void;

export interface ServerlessOptions extends CreateDepsOptions {
  env?: NodeJS.ProcessEnv;
  /** Use this database instead of createDb(env) (tests: PGlite). */
  db?: Db;
  config?: CoreConfig;
  /** Schedule work after the response. Default: @vercel/functions waitUntil when installed, else none (inline drain). */
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
      const config = opts.config ?? loadConfig({ ...env, PACELINE_MODE: env.PACELINE_MODE ?? 'serverless' });
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
      if (waitUntil) waitUntil(run(WAIT_UNTIL_DRAIN_BUDGET_MS));
      else await run(opts.afterDrainBudgetMs ?? AFTER_DRAIN_BUDGET_MS);
    }
    return res;
  }) as ServerlessHandler;
  handler.ready = async () => {
    const { app, deps } = await boot();
    return { app, deps };
  };
  return handler;
}
