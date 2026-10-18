/** JobQueue on `public.jobs` via api.enqueue_job / claim_jobs / complete_job / fail_job. */
import type { Db } from '@paceline/db';
import type { CoreDeps, JobHandler, JobQueue } from '../contracts.js';

/** Jobs go dead after this many attempts. Backoff: 5 s × 2^attempts, capped at 1 h (api.fail_job). */
export const JOB_MAX_ATTEMPTS = 10;
const LEASE = '5 minutes';

interface JobRow {
  id: string | number;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export class PgJobQueue implements JobQueue {
  private draining = false;
  private deps: CoreDeps | null = null;

  constructor(
    private readonly db: Db,
    private readonly handlers: Record<string, JobHandler>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  bind(deps: CoreDeps): void {
    this.deps = deps;
  }

  async enqueue(
    topic: string,
    payload: Record<string, unknown>,
    opts: { dedupeKey?: string; runAfterMs?: number; tx?: import('@paceline/db').Tx } = {},
  ): Promise<void> {
    const runAfter = opts.runAfterMs ? new Date(this.now().getTime() + opts.runAfterMs).toISOString() : null;
    const sql = 'select api.enqueue_job($1, $2::jsonb, $3, $4::timestamptz, $5) as id';
    const params = [topic, JSON.stringify(payload), opts.dedupeKey ?? null, runAfter, JOB_MAX_ATTEMPTS];
    if (opts.tx) await opts.tx.query(sql, params);
    else await this.db.asService((tx) => tx.query(sql, params));
  }

  async drain(n = 10): Promise<number> {
    return (await this.drainDetailed(n)).claimed;
  }

  /** drain() with per-outcome counts (the jobs tick reports them). */
  async drainDetailed(n = 10): Promise<{ claimed: number; completed: number; failed: number }> {
    const topics = Object.keys(this.handlers);
    if (topics.length === 0 || this.draining || !this.deps) return { claimed: 0, completed: 0, failed: 0 };
    let completed = 0;
    let failed = 0;
    this.draining = true;
    try {
      const claimed = await this.db.asService((tx) =>
        tx.query<JobRow>('select id, topic, payload, attempts from api.claim_jobs($1::text[], $2, $3::interval)', [
          topics,
          n,
          LEASE,
        ]),
      );
      for (const job of claimed.rows) {
        const handler = this.handlers[job.topic];
        try {
          if (!handler) throw new Error(`no handler for ${job.topic}`);
          await handler(job.payload ?? {}, this.deps);
          await this.db.asService((tx) => tx.query('select api.complete_job($1, $2)', [job.id, job.attempts]));
          completed++;
        } catch (e) {
          // Error class + message only; handlers never put user content in errors.
          const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          this.deps.log('warn', 'job failed', { topic: job.topic, id: String(job.id), attempts: job.attempts, err: msg.slice(0, 300) });
          await this.db.asService((tx) => tx.query('select api.fail_job($1, $2, null, $3)', [job.id, msg.slice(0, 2000), job.attempts]));
          failed++;
        }
      }
      return { claimed: claimed.rows.length, completed, failed };
    } finally {
      this.draining = false;
    }
  }
}
