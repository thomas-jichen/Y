/**
 * PLATFORM module (owner: core-platform): config, auth, job queue, push bus,
 * hook REST (ingest/brief/match), dev auth, onboarding, web JSON API, SSE, the
 * posts + scrolls web API (posts/) and the capture → publish → distill →
 * review pipeline jobs.
 */
import { fileURLToPath } from 'node:url';
import { migrate, type Db } from '@y/db';
import type { JWTVerifyGetKey } from 'jose';
import type { CoreConfig, CoreDeps, CoreModule } from '../contracts.js';
import { PlatformAuth } from './auth.js';
import { PgPushBus } from './bus.js';
import { createCoreEmbedder } from './embedder.js';
import { ServerlessPushBus } from './serverless-bus.js';
import { registerJobsRoutes } from './routes/jobs.js';
import { registerStreamTokenRoute } from './routes/stream-token.js';
import { PgJobQueue } from './jobs.js';
import { PLATFORM_JOBS, scheduleCloseIdle } from './pipeline.js';
import { registerConnectRoutes } from './routes/connect.js';
import { registerDevRoutes } from './routes/dev.js';
import { registerHookRoutes } from './routes/hook.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerWebRoutes } from './routes/web.js';
import { registerPostsRoutes } from '../posts/index.js';

export { loadConfig } from './config.js';
export {
  PlatformAuth,
  PULSE_TOKEN_TTL_S,
  STREAM_TOKEN_TTL_S,
  STEP_UP_MAX_AGE_S,
  installCaller,
  webCaller,
  supabaseAuthTime,
} from './auth.js';
export { PgPushBus } from './bus.js';
export { ServerlessPushBus, SERVERLESS_MAX_WAIT_MS } from './serverless-bus.js';
export { PgJobQueue, JOB_MAX_ATTEMPTS } from './jobs.js';
export { createCoreMockEmbedder, createCoreEmbedder, CORE_EMBEDDING_DIMS } from './embedder.js';
export { drainWithBudget } from './routes/jobs.js';
export { registerWebGuards } from './web-guard.js';
export { heuristicDrafts } from './distill.js';
export { PLATFORM_JOBS } from './pipeline.js';

/** apps/core/migrations: applied after supabase/migrations (dev web sessions). */
export const CORE_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export interface CreateDepsOptions {
  /** Skip the recurring close_idle schedule (tests). */
  scheduleRecurring?: boolean;
  now?: () => Date;
  log?: CoreDeps['log'];
  /** Apply apps/core/migrations (default: true in server mode, false in serverless: run `pnpm migrate`). */
  migrateCore?: boolean;
  /** Injected fetch for outbound calls (Realtime REST, gte embedder). Tests. */
  fetch?: typeof fetch;
  /** Override the Supabase JWKS (tests). */
  jwks?: JWTVerifyGetKey;
  /** Serverless long-poll tuning (tests). */
  serverlessPollMs?: number;
}

function defaultLog(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void {
  if (level === 'debug' && !process.env.Y_DEBUG) return;
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
  if (opts.migrateCore ?? config.mode === 'server') await migrateCore(db);
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? defaultLog;
  if (config.llm !== 'mock') log('warn', 'llm=anthropic is not wired in v0; distill uses the deterministic heuristic');
  const auth = new PlatformAuth(config, db, now, opts.jwks ? { jwks: opts.jwks } : {});
  const bus =
    config.mode === 'serverless'
      ? new ServerlessPushBus(db, log, config, {
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
          ...(opts.serverlessPollMs ? { pollMs: opts.serverlessPollMs } : {}),
        })
      : new PgPushBus(db, log);
  await bus.start();
  const jobs = new PgJobQueue(db, { ...PLATFORM_JOBS, ...handlers }, now);
  const embedder = createCoreEmbedder(config, opts.fetch ? { fetch: opts.fetch } : {}, log);
  const deps: CoreDeps = { config, db, auth, bus, jobs, embedder, now, log };
  jobs.bind(deps);
  if (opts.scheduleRecurring ?? config.mode === 'server') await scheduleCloseIdle(deps);
  return deps;
}

/** Apply apps/core/migrations (after supabase/migrations). */
export async function migrateCore(db: Db, log?: (line: string) => void): Promise<void> {
  await migrate(db, { migrationsDir: CORE_MIGRATIONS_DIR, shims: false, ...(log ? { log } : {}) });
}

export const platformModule: CoreModule = {
  register(app, deps) {
    registerJobsRoutes(app, deps);
    registerStreamTokenRoute(app, deps);
    registerDevRoutes(app, deps);
    registerConnectRoutes(app, deps);
    registerHookRoutes(app, deps);
    registerWebRoutes(app, deps);
    registerUsageRoutes(app, deps);
    registerPostsRoutes(app, deps);
  },
  jobs: PLATFORM_JOBS,
};
