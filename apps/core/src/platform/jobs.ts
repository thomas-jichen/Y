/** JobQueue on `public.jobs` via api.enqueue_job / claim_jobs / complete_job / fail_job. */
import type { Db } from '@y/db';
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
    opts: { dedupeKey?: string; runAfterMs?: number; tx?: import('@y/db').Tx } = {},
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

  /**
   * drain() with per-outcome counts (the jobs tick reports them). Runs up to `n` of the jobs
   * that are due when it starts. Each job is claimed only right before it runs, so a worker
   * killed mid-drain (serverless maxDuration) strands at most the job it was running, never an
   * unstarted tail whose attempts would be burned by lease expiry. `deadlineMs` (epoch ms) stops
   * claiming new jobs once passed; unclaimed jobs stay queued and untouched.
   */
  async drainDetailed(n = 10, opts: { deadlineMs?: number } = {}): Promise<{ claimed: number; completed: number; failed: number }> {
    const topics = Object.keys(this.handlers);
    if (topics.length === 0 || this.draining || !this.deps) return { claimed: 0, completed: 0, failed: 0 };
    let claimed = 0;
    let completed = 0;
    let failed = 0;
    this.draining = true;
    try {
      const due = await this.db.asService(async (tx) => {
        // As api.claim_jobs: an expired lease on the last attempt is dead.
        await tx.query(
          `update public.jobs j set state = 'dead', locked_until = null, finished_at = now(),
               last_error = coalesce(j.last_error, 'lease expired on the last attempt')
            where j.state = 'running' and j.locked_until < now() and j.attempts >= j.max_attempts and j.topic = any ($1::text[])`,
          [topics],
        );
        return tx.query<{ id: string | number }>(
          `select j.id from public.jobs j
            where j.topic = any ($1::text[]) and j.attempts < j.max_attempts
              and ((j.state = 'queued' and j.run_after <= now()) or (j.state = 'running' and j.locked_until < now()))
            order by j.run_after, j.id
            limit $2`,
          [topics, Math.max(1, Math.min(n, 100))],
        );
      });
      for (const { id } of due.rows) {
        if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) break;
        const job = await this.claimOne(id);
        if (!job) continue; // another worker took it, or it is no longer due
        claimed++;
        const handler = this.handlers[job.topic];
        try {
          if (!handler) throw new Error(`no handler for ${job.topic}`);
          await handler(job.payload ?? {}, this.deps);
          const ok = await this.db.asService((tx) => tx.query<{ ok: boolean }>('select api.complete_job($1, $2) as ok', [job.id, job.attempts]));
          // Fencing: the lease expired and another worker reclaimed the job while this one ran it.
          if (ok.rows[0]?.ok === false) this.deps.log('warn', 'job completed after its lease was reclaimed', { topic: job.topic, id: String(job.id), attempts: job.attempts });
          completed++;
        } catch (e) {
          // Error class + message only; handlers never put user content in errors.
          const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          this.deps.log('warn', 'job failed', { topic: job.topic, id: String(job.id), attempts: job.attempts, err: msg.slice(0, 300) });
          await this.db.asService((tx) => tx.query('select api.fail_job($1, $2, null, $3)', [job.id, msg.slice(0, 2000), job.attempts]));
          failed++;
        }
      }
      return { claimed, completed, failed };
    } finally {
      this.draining = false;
    }
  }

  /** Claim one job if it is still due (the same rule as api.claim_jobs; SKIP LOCKED). Each claim counts an attempt. */
  private async claimOne(id: string | number): Promise<JobRow | null> {
    const r = await this.db.asService((tx) =>
      tx.query<JobRow>(
        `update public.jobs j
            set state = 'running', attempts = j.attempts + 1, locked_until = now() + $2::interval, started_at = now()
          where j.id = (
            select x.id from public.jobs x
             where x.id = $1 and x.attempts < x.max_attempts
               and ((x.state = 'queued' and x.run_after <= now()) or (x.state = 'running' and x.locked_until < now()))
             for update skip locked)
          returning j.id, j.topic, j.payload, j.attempts`,
        [id, LEASE],
      ),
    );
    return r.rows[0] ?? null;
  }
}
