/**
 * The detached uploader: drains the outbox FIFO under a lock file,
 * `POST /api/v1/ingest` per chunk, deletes on 2xx, retries with backoff,
 * moves a chunk to `outbox/dead` after 10 failed attempts, and stores the
 * pulse summary from each response in `state/pulse.json`.
 *
 * - Connectivity errors (offline, DNS, refused, unreachable) never count
 *   toward dead-lettering: the run backs off and, after a few in a row,
 *   stops; the next Stop or SessionStart tries again. Timeouts and dropped
 *   connections do count, against a higher cap ({@link MAX_NETWORK_ATTEMPTS}),
 *   so a chunk that core or a proxy always chokes on still moves aside.
 * - A chunk dead-lettered by 5xx responses (a core outage) is re-driven to
 *   the outbox once the outage had time to end (at most
 *   {@link MAX_REDRIVES} times, while the chunk is under 7 days old). 4xx
 *   rejections are never re-driven.
 * - With the `ingest` kill switch engaged (cached brief, refreshed by the
 *   listener's pulses, or here by a brief fetch when the switches are older
 *   than {@link KILL_SWITCH_REFRESH_MS}) chunks stay in the outbox and
 *   nothing is sent.
 * - `state/setup-sent.json` records a setup snapshot's hash only once a chunk
 *   carrying that snapshot was accepted (2xx). If core rejects a chunk
 *   outright (400/413/422) while it carries a snapshot, the snapshot is
 *   dropped from that chunk and its hash recorded as rejected, so one bad
 *   snapshot can't cost every later chunk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KillSwitches } from '@y/schema/common';
import { IngestResponse } from '@y/schema/ingest';
import {
  ensureDir,
  httpJson,
  logLine,
  pidAlive,
  PLUGIN_VERSION,
  readJson,
  sleep,
  storedToken,
  writeJsonAtomic,
  type Config,
  type FetchLike,
  type Paths,
} from './runtime.js';
import { listChunks } from './outbox.js';
import { repoAllowed } from './gating.js';
import { killSwitchesSeenAt, mergeKillSwitches, readBrief, setupSentFile, updatePulse } from './state.js';

export const MAX_ATTEMPTS = 10;
/** Consecutive network errors after which a run gives up. */
export const MAX_NETWORK_ERRORS_PER_RUN = 6;
/** Timeouts / dropped connections on one chunk before it is dead-lettered (connectivity errors never count). */
export const MAX_NETWORK_ATTEMPTS = 20;
/** Times a 5xx dead-lettered chunk is put back in the outbox. */
export const MAX_REDRIVES = 3;
/** A 5xx dead-lettered chunk waits this long before a re-drive (let the outage end). */
export const REDRIVE_AFTER_MS = 10 * 60_000;
/** Chunks older than this are never re-driven. */
export const REDRIVE_MAX_AGE_MS = 7 * 24 * 3600_000;
/** Refresh the kill switches from a brief when the cached ones are older than this. */
export const KILL_SWITCH_REFRESH_MS = 60_000;
/** Responses that reject the chunk itself (validation, size): the snapshot may be the cause. */
const DEFINITIVE_REJECTIONS = new Set([400, 413, 422]);
/** Errors that mean "not connected": no request reached core, so the chunk isn't at fault. */
const CONNECTIVITY_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);
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
  /** The token Claude Code has stored now, tried once on a 401 (default: storedToken). */
  currentToken?: () => string | undefined;
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

interface Attempts {
  /** Failed HTTP attempts (5xx, 4xx other than 429). */
  n: number;
  /** Timeouts / dropped connections. */
  net?: number;
}

function readAttempts(chunk: string): Attempts {
  const a = readJson<Attempts>(attemptsFile(chunk));
  return { n: typeof a?.n === 'number' ? a.n : 0, ...(typeof a?.net === 'number' ? { net: a.net } : {}) };
}

function bumpAttempts(chunk: string): number {
  const a = readAttempts(chunk);
  const n = a.n + 1;
  writeJsonAtomic(attemptsFile(chunk), { ...a, n });
  return n;
}

function bumpNetworkAttempts(chunk: string): number {
  const a = readAttempts(chunk);
  const net = (a.net ?? 0) + 1;
  writeJsonAtomic(attemptsFile(chunk), { ...a, net });
  return net;
}

/** Why a chunk was dead-lettered; only `5xx` (core outage, incl. 408) is re-driven. */
type DeadClass = '5xx' | 'rejected' | 'network' | 'invalid';

interface DeadMeta {
  class: DeadClass;
  deadAt: number;
  redrives: number;
}

/** `outbox/.dead-meta/<chunk>`: kept beside, not inside, `outbox/dead`. */
function deadMetaFile(p: Paths, name: string): string {
  return path.join(p.outbox, '.dead-meta', name);
}

function readDeadMeta(p: Paths, name: string): DeadMeta | undefined {
  const m = readJson<DeadMeta>(deadMetaFile(p, name));
  if (!m || typeof m.deadAt !== 'number' || typeof m.redrives !== 'number') return undefined;
  return m;
}

function moveToDead(p: Paths, chunk: string, cls: DeadClass, now: number): void {
  ensureDir(p.dead);
  const name = path.basename(chunk);
  fs.renameSync(chunk, path.join(p.dead, name));
  fs.rmSync(attemptsFile(chunk), { force: true });
  try {
    ensureDir(path.dirname(deadMetaFile(p, name)));
    writeJsonAtomic(deadMetaFile(p, name), { class: cls, deadAt: now, redrives: readDeadMeta(p, name)?.redrives ?? 0 } satisfies DeadMeta);
  } catch {
    /* best effort: without a record the chunk is simply not re-driven */
  }
}

/** Chunk files are `<ts13>-…json`: their creation time. */
function chunkTime(name: string): number | undefined {
  const m = /^(\d{13})-/.exec(name);
  return m ? Number(m[1]) : undefined;
}

/**
 * Put chunks that a core outage (5xx) dead-lettered back in the outbox once
 * the outage had time to end. Bounded: {@link MAX_REDRIVES} per chunk, and
 * only while it is under {@link REDRIVE_MAX_AGE_MS} old. Runs under the
 * uploader lock. Returns how many were re-driven.
 */
export function redriveDead(p: Paths, now: number): number {
  let names: string[];
  try {
    names = fs.readdirSync(p.dead).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    const meta = readDeadMeta(p, name);
    const born = chunkTime(name);
    if (!meta || meta.class !== '5xx' || meta.redrives >= MAX_REDRIVES) continue;
    if (now - meta.deadAt < REDRIVE_AFTER_MS || born === undefined || now - born > REDRIVE_MAX_AGE_MS) continue;
    try {
      fs.renameSync(path.join(p.dead, name), path.join(p.outbox, name));
      writeJsonAtomic(deadMetaFile(p, name), { ...meta, redrives: meta.redrives + 1 } satisfies DeadMeta);
      n++;
    } catch {
      /* best effort */
    }
  }
  return n;
}

/** Offline (no connection was made) vs. a request that failed after reaching the network path. */
function isConnectivityError(e: unknown): boolean {
  const err = e as { name?: unknown; code?: unknown; cause?: { code?: unknown; name?: unknown } } | null;
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false; // our own deadline: core may be choking on this chunk
  const code = typeof err.code === 'string' ? err.code : typeof err.cause?.code === 'string' ? err.cause.code : undefined;
  if (code) return CONNECTIVITY_CODES.has(code);
  // `fetch failed` with no cause code (non-Node runtimes): treat as offline.
  return err.name === 'TypeError' && err.cause?.name !== 'AbortError';
}

/** Drop the snapshot from a chunk core rejected outright; returns true when the chunk was rewritten. */
function dropRejectedSnapshot(p: Paths, file: string, body: unknown): boolean {
  const b = body as { setup?: { hash?: unknown; snapshot?: unknown } } | null;
  if (!b || typeof b !== 'object' || !b.setup || typeof b.setup.hash !== 'string' || !b.setup.snapshot) return false;
  try {
    writeJsonAtomic(file, { ...b, setup: { hash: b.setup.hash } });
    // Stop sends only the hash from now on (until the setup changes), as for an accepted snapshot.
    writeJsonAtomic(setupSentFile(p), { hash: b.setup.hash, rejected: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sessions with no listener (wake_on_dm=off, headless, none spawned yet)
 * never see a pulse: fetch the brief (no side effects) when the cached kill
 * switches are older than {@link KILL_SWITCH_REFRESH_MS} and record its
 * switches. Only when a brief is cached (SessionStart ran); best effort.
 */
async function refreshKillSwitches(o: UploaderOpts, token: string, now: number): Promise<void> {
  const seen = killSwitchesSeenAt(o.paths);
  if (seen === undefined || now - seen < KILL_SWITCH_REFRESH_MS) return;
  try {
    const q = new URLSearchParams({ pluginVersion: PLUGIN_VERSION });
    const res = await httpJson(o.fetch, 'GET', `${o.config.apiUrl}/api/v1/agent/brief?${q}`, { token, timeoutMs: 5_000 });
    if (res.status < 200 || res.status >= 300 || !res.body || typeof res.body !== 'object') return;
    const ks = KillSwitches.safeParse((res.body as { killSwitches?: unknown }).killSwitches);
    if (ks.success) mergeKillSwitches(o.paths, ks.data, now);
  } catch {
    /* offline: keep the cached switches */
  }
}

function recordSetupSent(p: Paths, body: unknown): void {
  const setup = (body as { setup?: { hash?: unknown; snapshot?: unknown } } | null)?.setup;
  if (!setup || typeof setup.hash !== 'string' || !setup.snapshot) return;
  try {
    writeJsonAtomic(setupSentFile(p), { hash: setup.hash });
  } catch {
    /* best effort: the next Stop sends the snapshot again */
  }
}

export async function drainOutbox(o: UploaderOpts): Promise<UploadSummary> {
  const now = o.now ?? Date.now;
  const wait = o.sleep ?? sleep;
  const backoff = o.backoffMs ?? 1000;
  const start = now();
  const budget = o.budgetMs ?? 90_000;
  const summary: UploadSummary = { sent: 0, dead: 0, remaining: 0, locked: false };
  if (!o.config.token) return { ...summary, remaining: listChunks(o.paths).length };
  if (listChunks(o.paths).length > 0) await refreshKillSwitches(o, o.config.token, start);
  // Kill switch: "clients keep chunks in the outbox and don't upload" (KillSwitches.ingest).
  if (readBrief(o.paths)?.killSwitches.ingest) return { ...summary, remaining: listChunks(o.paths).length };
  if (!acquireLock(o.paths, start)) return { ...summary, locked: true, remaining: listChunks(o.paths).length };
  let token = o.config.token;
  let refreshed = false;
  let netErrors = 0;
  try {
    redriveDead(o.paths, start);
    for (;;) {
      const next = listChunks(o.paths)[0];
      if (!next) break;
      if (now() - start > budget) break;
      let body: unknown;
      try {
        body = JSON.parse(fs.readFileSync(next, 'utf8'));
      } catch {
        moveToDead(o.paths, next, 'invalid', now());
        summary.dead++;
        continue;
      }
      // Repo gating: a chunk queued for a repo the team has not linked (or before gating) is
      // dropped here, never sent.
      const chunkRepo = body && typeof body === 'object' ? (body as { repoKey?: unknown }).repoKey : undefined;
      if (!repoAllowed(readBrief(o.paths), typeof chunkRepo === 'string' ? chunkRepo : undefined)) {
        fs.rmSync(next, { force: true });
        fs.rmSync(attemptsFile(next), { force: true });
        continue;
      }
      let status = 0;
      let retryAfterS: number | undefined;
      let resBody: unknown;
      let networkError: 'offline' | 'counted' | undefined;
      try {
        const res = await httpJson(o.fetch, 'POST', `${o.config.apiUrl}/api/v1/ingest`, {
          token,
          body,
          timeoutMs: 15_000,
        });
        status = res.status;
        retryAfterS = res.retryAfterS;
        resBody = res.body;
      } catch (e) {
        networkError = isConnectivityError(e) ? 'offline' : 'counted';
        logLine(o.config.dataDir, 'uploader', `network error (${networkError}): ${(e as Error)?.message ?? e}`.slice(0, 300));
      }
      if (networkError) {
        // Offline is not the chunk's fault: back off without counting an attempt. A timeout or a
        // dropped connection may be (a body core always chokes on): count it against a higher cap.
        if (networkError === 'counted' && bumpNetworkAttempts(next) >= MAX_NETWORK_ATTEMPTS) {
          moveToDead(o.paths, next, 'network', now());
          summary.dead++;
          netErrors = 0;
          continue;
        }
        netErrors++;
        if (netErrors >= MAX_NETWORK_ERRORS_PER_RUN) break;
        const delay = Math.min(30_000, backoff * 2 ** (netErrors - 1));
        if (now() - start + delay > budget) break;
        await wait(delay);
        continue;
      }
      netErrors = 0;
      if (status >= 200 && status < 300) {
        fs.rmSync(next, { force: true });
        fs.rmSync(attemptsFile(next), { force: true });
        summary.sent++;
        fs.rmSync(deadMetaFile(o.paths, path.basename(next)), { force: true });
        recordSetupSent(o.paths, body);
        const r = IngestResponse.safeParse(resBody);
        if (r.success) updatePulse(o.paths, { cursor: r.data.pulse.cursor, unreadTotal: r.data.pulse.unread }, now());
        continue;
      }
      if (status) logLine(o.config.dataDir, 'uploader', `ingest ${path.basename(next)} → HTTP ${status}`);
      if (status === 401 && !refreshed) {
        // This process inherited a session's token, which may predate a reconnect.
        refreshed = true;
        const fresh = (o.currentToken ?? (() => storedToken(process.env)))();
        if (fresh && fresh !== token) {
          token = fresh;
          logLine(o.config.dataDir, 'uploader', 'retrying with the stored agent token');
          continue;
        }
      }
      if (status === 429) {
        // Rate limited (1 chunk / 5 s per session, burst 5): not a failure, so it never counts toward dead-lettering.
        const delay = Math.min(30_000, (retryAfterS ?? 5) * 1000);
        if (now() - start + delay > budget) break;
        await wait(delay);
        continue;
      }
      if (DEFINITIVE_REJECTIONS.has(status) && dropRejectedSnapshot(o.paths, next, body)) {
        logLine(o.config.dataDir, 'uploader', `ingest ${path.basename(next)} rejected with a setup snapshot: retrying without it`);
        continue;
      }
      const n = bumpAttempts(next);
      if (n >= MAX_ATTEMPTS) {
        moveToDead(o.paths, next, status >= 500 || status === 408 ? '5xx' : 'rejected', now());
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
