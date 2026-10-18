/**
 * Local wake budget (S1 "Decision": a backend bug must never become unbounded
 * model turns). Every exit-2 wake on this machine is recorded in
 * `state/wake-budget.json`; a wake is allowed only when
 *
 * - the previous wake was at least {@link WAKE_MIN_INTERVAL_MS} ago,
 * - fewer than {@link WAKE_MAX_PER_HOUR} wakes happened in the last hour, and
 * - fewer than {@link WAKE_MAX_PER_DAY} in the last 24 hours.
 *
 * The budget is per machine (one file in the data dir), not per session: N
 * sessions must not multiply the ceiling. Over budget, the listener exits 0
 * and parks the pointer for UserPromptSubmit ({@link parkPendingWake}), so
 * the news is delivered on the human's next message instead.
 *
 * Core keeps its own server-side budget (wake_ledger); this one is defense
 * in depth and works even against a misbehaving server.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Pointer } from '@y/schema/pointers';
import { readJson, safeSid, writeJsonAtomic, type Paths } from './runtime.js';

export const WAKE_MIN_INTERVAL_MS = 60_000;
export const WAKE_MAX_PER_HOUR = 6;
export const WAKE_MAX_PER_DAY = 30;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type BudgetVerdict = { allow: true } | { allow: false; reason: 'interval' | 'hour' | 'day' | 'busy' };

/** A lock older than this is from a crashed listener and is broken. */
export const WAKE_LOCK_STALE_MS = 5_000;
/** How long takeWake spins for a lock another listener holds (it is held for a read and a write). */
export const WAKE_LOCK_SPIN_MS = 150;
const SPIN_STEP_MS = 5;

interface BudgetFile {
  /** Epoch ms of recent wakes (last 24 h only), ascending. */
  wakes: number[];
}

function budgetFile(p: Paths): string {
  return path.join(p.state, 'wake-budget.json');
}

function readWakes(p: Paths, now: number): number[] {
  const f = readJson<BudgetFile>(budgetFile(p));
  const raw = f && Array.isArray(f.wakes) ? f.wakes : [];
  return raw
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > now - DAY_MS && t <= now + 60_000)
    .sort((a, b) => a - b)
    .slice(-WAKE_MAX_PER_DAY * 2);
}

/** Pure check over a list of past wake times. */
export function checkBudget(wakes: readonly number[], now: number): BudgetVerdict {
  const recent = wakes.filter((t) => t > now - DAY_MS);
  const last = recent.length ? Math.max(...recent) : undefined;
  // A wake "in the future" (clock moved back) also counts as too recent.
  if (last !== undefined && now - last < WAKE_MIN_INTERVAL_MS) return { allow: false, reason: 'interval' };
  if (recent.filter((t) => t > now - HOUR_MS).length >= WAKE_MAX_PER_HOUR) return { allow: false, reason: 'hour' };
  if (recent.length >= WAKE_MAX_PER_DAY) return { allow: false, reason: 'day' };
  return { allow: true };
}

function lockDir(p: Paths): string {
  return path.join(p.state, 'wake-budget.lock');
}

/** `mkdir` is atomic: exactly one listener holds the lock. A stale lock (crash) is broken once. */
function acquireWakeLock(p: Paths): boolean {
  const dir = lockDir(p);
  fs.mkdirSync(p.state, { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(dir);
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs < WAKE_LOCK_STALE_MS) return false;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      return true;
    } catch {
      return false;
    }
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no Atomics.wait: retry at once */
  }
}

/**
 * Check the budget and, when allowed, record the wake, under a short lock so
 * two listeners can't both pass the check and overwrite each other's entry.
 * Another listener holds the lock only for a read and a write, so this spins
 * up to {@link WAKE_LOCK_SPIN_MS} for it; only if it is still held is the
 * verdict `busy` (the caller parks the pointer and keeps listening).
 */
export function takeWake(p: Paths, now: number, spinMs: number = WAKE_LOCK_SPIN_MS): BudgetVerdict {
  const until = Date.now() + spinMs;
  let locked = acquireWakeLock(p);
  while (!locked && Date.now() < until) {
    sleepSync(SPIN_STEP_MS);
    locked = acquireWakeLock(p);
  }
  if (!locked) return { allow: false, reason: 'busy' };
  try {
    const wakes = readWakes(p, now);
    const v = checkBudget(wakes, now);
    if (v.allow) writeJsonAtomic(budgetFile(p), { wakes: [...wakes, now] } satisfies BudgetFile);
    return v;
  } finally {
    fs.rmSync(lockDir(p), { recursive: true, force: true });
  }
}

/* ======================================================= pending wake */

/** A wake the budget deferred, delivered by UserPromptSubmit on the next human message. */
export interface PendingWake {
  pointer: Pointer;
  at: number;
}

/** Pending wakes older than this are dropped (the counts in pulse.json still point). */
export const PENDING_WAKE_TTL_MS = DAY_MS;

function pendingFile(p: Paths, sid: string): string {
  return path.join(p.state, `pending-wake-${safeSid(sid)}.json`);
}

/** Park a validated pointer for UserPromptSubmit (newest wins). */
export function parkPendingWake(p: Paths, sid: string, pointer: Pointer, now: number): void {
  const v = Pointer.safeParse(pointer);
  if (!v.success) return;
  writeJsonAtomic(pendingFile(p, sid), { pointer: v.data, at: now } satisfies PendingWake);
}

/** Read and remove the parked pointer (re-validated; stale or malformed → undefined). */
export function takePendingWake(p: Paths, sid: string, now: number): Pointer | undefined {
  const file = pendingFile(p, sid);
  const raw = readJson<PendingWake>(file);
  if (raw === undefined) return undefined;
  fs.rmSync(file, { force: true });
  if (!raw || typeof raw.at !== 'number' || now - raw.at > PENDING_WAKE_TTL_MS) return undefined;
  const v = Pointer.safeParse(raw.pointer);
  return v.success ? v.data : undefined;
}
