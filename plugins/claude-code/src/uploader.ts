/**
 * The detached uploader: drains the outbox FIFO under a lock file,
 * `POST /api/v1/ingest` per chunk, deletes on 2xx, retries with backoff,
 * moves a chunk to `outbox/dead` after 10 failed attempts, and stores the
 * pulse summary from each response in `state/pulse.json`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IngestResponse } from '@paceline/schema/ingest';
import {
  ensureDir,
  httpJson,
  logLine,
  pidAlive,
  readJson,
  sleep,
  writeJsonAtomic,
  type Config,
  type FetchLike,
  type Paths,
} from './runtime.js';
import { listChunks } from './outbox.js';
import { updatePulse } from './state.js';

export const MAX_ATTEMPTS = 10;
const LOCK_STALE_MS = 5 * 60_000;

export interface UploaderOpts {
  config: Config;
  paths: Paths;
  fetch: FetchLike;
  now?: () => number;
  /** Total run budget (default 90 s; `--final` 20 s). */
  budgetMs?: number;
  /** Base backoff (default 1 s, doubles per attempt, capped at 30 s). */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface UploadSummary {
  sent: number;
  dead: number;
  remaining: number;
  locked: boolean;
}

function acquireLock(p: Paths, now: number): boolean {
  ensureDir(p.outbox);
  const tryCreate = () => {
    const fd = fs.openSync(p.uploaderLock, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now }));
    fs.closeSync(fd);
  };
  try {
    tryCreate();
    return true;
  } catch {
    const held = readJson<{ pid?: number; at?: number }>(p.uploaderLock);
    const stale = !held || !pidAlive(held.pid ?? -1) || now - (held.at ?? 0) > LOCK_STALE_MS;
    if (!stale) return false;
    try {
      fs.rmSync(p.uploaderLock, { force: true });
      tryCreate();
      return true;
    } catch {
      return false;
    }
  }
}

function attemptsFile(chunk: string): string {
  return path.join(path.dirname(chunk), `.${path.basename(chunk)}.attempts`);
}

function bumpAttempts(chunk: string): number {
  const f = attemptsFile(chunk);
  const n = (readJson<{ n?: number }>(f)?.n ?? 0) + 1;
  writeJsonAtomic(f, { n });
  return n;
}

function moveToDead(p: Paths, chunk: string): void {
  ensureDir(p.dead);
  fs.renameSync(chunk, path.join(p.dead, path.basename(chunk)));
  fs.rmSync(attemptsFile(chunk), { force: true });
}

export async function drainOutbox(o: UploaderOpts): Promise<UploadSummary> {
  const now = o.now ?? Date.now;
  const wait = o.sleep ?? sleep;
  const backoff = o.backoffMs ?? 1000;
  const start = now();
  const budget = o.budgetMs ?? 90_000;
  const summary: UploadSummary = { sent: 0, dead: 0, remaining: 0, locked: false };
  if (!o.config.token) return { ...summary, remaining: listChunks(o.paths).length };
  if (!acquireLock(o.paths, start)) return { ...summary, locked: true, remaining: listChunks(o.paths).length };
  try {
    for (;;) {
      const next = listChunks(o.paths)[0];
      if (!next) break;
      if (now() - start > budget) break;
      let body: unknown;
      try {
        body = JSON.parse(fs.readFileSync(next, 'utf8'));
      } catch {
        moveToDead(o.paths, next);
        summary.dead++;
        continue;
      }
      let status = 0;
      let retryAfterS: number | undefined;
      let resBody: unknown;
      try {
        const res = await httpJson(o.fetch, 'POST', `${o.config.apiUrl}/api/v1/ingest`, {
          token: o.config.token,
          body,
          timeoutMs: 15_000,
        });
        status = res.status;
        retryAfterS = res.retryAfterS;
        resBody = res.body;
      } catch (e) {
        logLine(o.config.dataDir, 'uploader', `network error: ${(e as Error)?.message ?? e}`.slice(0, 300));
      }
      if (status >= 200 && status < 300) {
        fs.rmSync(next, { force: true });
        fs.rmSync(attemptsFile(next), { force: true });
        summary.sent++;
        const r = IngestResponse.safeParse(resBody);
        if (r.success) updatePulse(o.paths, { cursor: r.data.pulse.cursor, unreadTotal: r.data.pulse.unread }, now());
        continue;
      }
      if (status) logLine(o.config.dataDir, 'uploader', `ingest ${path.basename(next)} → HTTP ${status}`);
      if (status === 429) {
        // Rate limited (1 chunk / 5 s per session, burst 5): not a failure, so it never counts toward dead-lettering.
        const delay = Math.min(30_000, (retryAfterS ?? 5) * 1000);
        if (now() - start + delay > budget) break;
        await wait(delay);
        continue;
      }
      const n = bumpAttempts(next);
      if (n >= MAX_ATTEMPTS) {
        moveToDead(o.paths, next);
        summary.dead++;
        continue;
      }
      // FIFO per session: stop at the head and retry it after a backoff.
      const delay = Math.min(30_000, retryAfterS ? retryAfterS * 1000 : backoff * 2 ** (n - 1));
      if (now() - start + delay > budget) break;
      await wait(delay);
    }
  } finally {
    fs.rmSync(o.paths.uploaderLock, { force: true });
  }
  summary.remaining = listChunks(o.paths).length;
  return summary;
}
