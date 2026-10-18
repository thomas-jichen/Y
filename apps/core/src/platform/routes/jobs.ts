/**
 * POST /internal/jobs/tick (packages/schema hosting.ts): the serverless job
 * drain, called every minute by pg_cron via pg_net with
 * `Authorization: Bearer <Y_CRON_SECRET>`. Drains due jobs until
 * JOBS_TICK_BUDGET_MS is spent or nothing is due, re-arms the recurring
 * close_idle job, and flushes Realtime REST broadcasts.
 */
import type { Hono } from 'hono';
import { JOBS_TICK_BUDGET_MS, JOBS_TICK_PATH, JobsTickRequest, type JobsTickResponse } from '@y/schema';
import type { CoreDeps } from '../../contracts.js';
import { PgJobQueue } from '../jobs.js';
import { scheduleCloseIdle } from '../pipeline.js';
import { ServerlessPushBus } from '../serverless-bus.js';
import { fail, parseOr, readJson, safeEqual, sha256Hex } from '../util.js';

export interface DrainResult {
  claimed: number;
  completed: number;
  failed: number;
}

/** Claim and run due jobs in batches until `budgetMs` is spent or nothing is due. Then flush realtime. */
export async function drainWithBudget(deps: CoreDeps, budgetMs: number, batch = 10): Promise<DrainResult> {
  const start = Date.now();
  const out: DrainResult = { claimed: 0, completed: 0, failed: 0 };
  while (Date.now() - start < budgetMs) {
    if (deps.jobs instanceof PgJobQueue) {
      const r = await deps.jobs.drainDetailed(batch);
      out.claimed += r.claimed;
      out.completed += r.completed;
      out.failed += r.failed;
      if (r.claimed === 0) break;
    } else {
      const n = await deps.jobs.drain(batch);
      out.claimed += n;
      out.completed += n;
      if (n === 0) break;
    }
  }
  if (deps.bus instanceof ServerlessPushBus) await deps.bus.flushRealtime();
  return out;
}

export function registerJobsRoutes(app: Hono, deps: CoreDeps): void {
  app.post(JOBS_TICK_PATH, async (c) => {
    const secret = deps.config.cronSecret ?? null;
    const m = /^Bearer\s+(\S{1,512})$/i.exec(c.req.header('authorization') ?? '');
    // Hash both sides so the compare is constant-time regardless of length.
    if (!secret || !m?.[1] || !safeEqual(sha256Hex(m[1]), sha256Hex(secret))) return fail(c, 'UNAUTHORIZED', 'bad tick secret');
    const body = parseOr(c, JobsTickRequest, (await readJson(c)) ?? { source: 'manual' });
    if (!body.ok) return body.res;
    const t0 = Date.now();
    if (body.data.due === 0) {
      if (deps.bus instanceof ServerlessPushBus) await deps.bus.flushRealtime();
      const idle: JobsTickResponse = { ok: true, mode: deps.config.mode, claimed: 0, completed: 0, failed: 0, remaining: 0, durationMs: Date.now() - t0 };
      return c.json(idle);
    }
    // Serverless has no in-process scheduler: keep the recurring close_idle job armed (deduped per bucket).
    if (deps.config.mode === 'serverless') await scheduleCloseIdle(deps);
    const r = await drainWithBudget(deps, JOBS_TICK_BUDGET_MS);
    const res: JobsTickResponse = { ok: true, mode: deps.config.mode, ...r, remaining: null, durationMs: Date.now() - t0 };
    return c.json(res);
  });
}
