/**
 * Segment boundaries and repo keys. Pure (repo keys use `node:crypto`).
 * @module segments
 */
import { createHmac } from 'node:crypto';
import type { Harness, SegmentCloseReason } from '@paceline/schema';
import { SEGMENT_CAP_MS, SEGMENT_IDLE_MS, type SegmentEvent, type SegmentState, type SegmentTransition } from './types.js';

/** Fresh state for a new session. */
export function newSegmentState(sessionId: string, harness: Harness, at: number): SegmentState {
  return { sessionId, harness, segmentIndex: 0, seq: 0, startedAt: at, lastEventAt: at, closed: false };
}

/**
 * Apply an event (pure): explicit closes (`clear`/`explicit_post` reopen,
 * `session_end` marks closed), `sweep`, idle timeout (≥30 min since the last
 * event) and the 4 h cap each close the current segment; otherwise only
 * `lastEventAt` advances.
 */
export function applySegmentEvent(state: SegmentState, event: SegmentEvent): SegmentTransition {
  const at = event.at;
  const reopen = (reason: SegmentCloseReason, start: number): SegmentTransition => ({
    state: { ...state, segmentIndex: state.segmentIndex + 1, startedAt: start, lastEventAt: start, closed: false },
    close: reason,
    opened: true,
  });
  if (state.closed) {
    // A closed session receiving activity starts a new segment.
    if (event.kind === 'session_end' || event.kind === 'sweep') return { state: { ...state }, close: null, opened: false };
    return { state: { ...state, segmentIndex: state.segmentIndex + 1, startedAt: at, lastEventAt: at, closed: false }, close: null, opened: true };
  }
  switch (event.kind) {
    case 'session_end':
      return { state: { ...state, lastEventAt: Math.max(state.lastEventAt, at), closed: true }, close: 'session_end', opened: false };
    case 'clear':
      return reopen('clear', at);
    case 'explicit_post':
      return reopen('explicit_post', at);
    case 'sweep':
      return { state: { ...state, closed: true }, close: 'sweep', opened: false };
    default:
      break;
  }
  if (at - state.lastEventAt >= SEGMENT_IDLE_MS) return reopen('idle_timeout', at);
  if (at - state.startedAt >= SEGMENT_CAP_MS) return reopen('cap', at);
  return { state: { ...state, lastEventAt: Math.max(state.lastEventAt, at) }, close: null, opened: false };
}

/**
 * Normalize a git remote (`git@github.com:Acme/API.git`,
 * `https://user@github.com/acme/api`, `ssh://git@github.com:22/acme/api.git`)
 * to `github.com/acme/api`. `undefined` for anything unrecognizable.
 */
export function normalizeGitRemote(remote: string): string | undefined {
  const r = remote.trim();
  if (!r || /\s/.test(r)) return undefined;
  let host: string | undefined;
  let path: string | undefined;
  const url = /^(?:[a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(r);
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(r);
  if (url) [host, path] = [url[1], url[2]];
  else if (scp) [host, path] = [scp[1], scp[2]];
  if (!host || !path) return undefined;
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '').replace(/^\/+/, '');
  if (!path.includes('/') || !/^[a-z0-9.-]+$/i.test(host)) return undefined;
  return `${host}/${path}`.toLowerCase();
}

/** Lowercase hex HMAC-SHA256(base64url-decoded `salt`, `normalizeGitRemote(remote)`). */
export function computeRepoKey(remote: string, salt: string): string | undefined {
  const norm = normalizeGitRemote(remote);
  if (!norm) return undefined;
  return createHmac('sha256', Buffer.from(salt, 'base64url')).update(norm).digest('hex');
}
