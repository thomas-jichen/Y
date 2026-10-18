/**
 * Local turn and session state for presence (the web app's "live" dot), all
 * plain files under `state/`, no network:
 *
 * - `turn-<sid>.json`: a turn is in progress. Written when UserPromptSubmit
 *   spawns the listener; removed by Stop (`listen.mjs mark`) and SessionEnd.
 *   The listener reports it on every pulse (`active=1`/`0`). Stop does not
 *   fire on Esc interrupts, so a marker only counts while the transcript (or
 *   the marker itself) changed within {@link TURN_IDLE_MS}.
 * - `ended-<sid>.json`: SessionEnd ran while a listener held this session's
 *   slot, so that listener stops heartbeating (a stale "listening") and
 *   removes the marker. A later SessionStart or UserPromptSubmit for the same
 *   id (resume) removes it too.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJson, safeSid, writeJsonAtomic, type Paths } from './runtime.js';

/** A turn with no transcript activity for this long is treated as over (Esc interrupt). */
export const TURN_IDLE_MS = 10 * 60_000;

function turnFile(p: Paths, sid: string): string {
  return path.join(p.state, `turn-${safeSid(sid)}.json`);
}

function endedFile(p: Paths, sid: string): string {
  return path.join(p.state, `ended-${safeSid(sid)}.json`);
}

export function startTurn(p: Paths, sid: string, now: number): void {
  writeJsonAtomic(turnFile(p, sid), { since: now });
}

export function endTurn(p: Paths, sid: string): void {
  fs.rmSync(turnFile(p, sid), { force: true });
}

function mtimeMs(file: string | undefined): number {
  if (!file) return 0;
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** True while a turn is in progress: a marker, and transcript or marker activity within TURN_IDLE_MS. */
export function turnActive(p: Paths, sid: string, now: number, transcriptPath?: string): boolean {
  const m = readJson<{ since?: unknown }>(turnFile(p, sid));
  if (!m) return false;
  const since = typeof m.since === 'number' && Number.isFinite(m.since) ? m.since : 0;
  return now - Math.max(since, mtimeMs(transcriptPath)) < TURN_IDLE_MS;
}

/** SessionEnd: the turn is over; if a listener holds the slot, tell it to stop (it removes the marker). */
export function markSessionEnded(p: Paths, sid: string, now: number): void {
  endTurn(p, sid);
  if (fs.existsSync(path.join(p.state, `listener-${safeSid(sid)}.json`))) writeJsonAtomic(endedFile(p, sid), { at: now });
}

export function sessionEnded(p: Paths, sid: string): boolean {
  return fs.existsSync(endedFile(p, sid));
}

export function clearSessionEnded(p: Paths, sid: string): void {
  fs.rmSync(endedFile(p, sid), { force: true });
}
