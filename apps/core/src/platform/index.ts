/**
 * PLATFORM module (owner: core-platform): config, auth, job queue, push bus,
 * hook REST (ingest/brief/match), dev auth, onboarding, web JSON API, SSE and
 * the capture → publish → distill → review pipeline jobs.
 */
import { fileURLToPath } from 'node:url';
import { migrate, type Db } from '@paceline/db';
import type { CoreConfig, CoreDeps, CoreModule } from '../contracts.js';
import { PlatformAuth } from './auth.js';
import { PgPushBus } from './bus.js';
import { createCoreMockEmbedder } from './embedder.js';
import { PgJobQueue } from './jobs.js';
import { PLATFORM_JOBS, scheduleCloseIdle } from './pipeline.js';
import { registerConnectRoutes } from './routes/connect.js';
import { registerDevRoutes } from './routes/dev.js';
import { registerHookRoutes } from './routes/hook.js';
import { registerWebRoutes } from './routes/web.js';

export { loadConfig } from './config.js';
export { PlatformAuth, PULSE_TOKEN_TTL_S, installCaller, webCaller } from './auth.js';
export { PgPushBus } from './bus.js';
export { PgJobQueue, JOB_MAX_ATTEMPTS } from './jobs.js';
export { createCoreMockEmbedder, CORE_EMBEDDING_DIMS } from './embedder.js';
export { heuristicDrafts } from './distill.js';
export { PLATFORM_JOBS } from './pipeline.js';

/** apps/core/migrations: applied after supabase/migrations (dev web sessions). */
export const CORE_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export interface CreateDepsOptions {
  /** Skip the recurring close_idle schedule (tests). */
  scheduleRecurring?: boolean;
  now?: () => Date;
  log?: CoreDeps['log'];
}

function defaultLog(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void {
  if (level === 'debug' && !process.env.PACELINE_DEBUG) return;
  const line = data ? `${msg} ${JSON.stringify(data)}` : msg;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[core] ${level} ${line}`);
}

/** Build CoreDeps (auth, bus, jobs, embedder) for a database. `handlers` = all modules' job handlers. */
export async function createDeps(
  config: CoreConfig,
  db: Db,
  handlers: CoreModule['jobs'],
  opts: CreateDepsOptions = {},
): Promise<CoreDeps> {
  await migrate(db, { migrationsDir: CORE_MIGRATIONS_DIR, shims: false });
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? defaultLog;
  if (config.embeddings !== 'mock') log('warn', `embeddings=${config.embeddings} is not wired in v0; using the mock embedder`);
  if (config.llm !== 'mock') log('warn', 'llm=anthropic is not wired in v0; distill uses the deterministic heuristic');
  const auth = new PlatformAuth(config, db, now);
  const bus = new PgPushBus(db, log);
  await bus.start();
  const jobs = new PgJobQueue(db, { ...PLATFORM_JOBS, ...handlers }, now);
  const deps: CoreDeps = { config, db, auth, bus, jobs, embedder: createCoreMockEmbedder(), now, log };
  jobs.bind(deps);
  if (opts.scheduleRecurring ?? config.mode === 'server') await scheduleCloseIdle(deps);
  return deps;
}

export const platformModule: CoreModule = {
  register(app, deps) {
    registerDevRoutes(app, deps);
    registerConnectRoutes(app, deps);
    registerHookRoutes(app, deps);
    registerWebRoutes(app, deps);
  },
  jobs: PLATFORM_JOBS,
};
