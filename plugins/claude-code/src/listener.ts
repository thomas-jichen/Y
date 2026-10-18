/**
 * The asyncRewake listener (SessionStart + Stop, timeout 3300 s). One live
 * listener per session (pid/generation file). It long-polls
 * `GET /api/v1/pulse?cursor&wait&sessionId`, writes `state/pulse.json`, and on
 * a wake targeted at this session writes the **rendered** pointer to stderr
 * and exits 2 (that wakes Claude). Backoff 5 s → 60 s on errors; exits 0 near
 * its timeout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KillSwitches } from '@paceline/schema/common';
import { Pointer } from '@paceline/schema/pointers';
import { PULSE_MAX_WAIT_S, UnreadCounts } from '@paceline/schema/pulse';
import { failOpen, OK, type HookCtx, type HookResult } from './context.js';
import { httpJson, pidAlive, readJson, safeSid, sleep, writeJsonAtomic } from './runtime.js';
import { fallbackText, readBrief, readPulse, renderOne, updatePulse } from './state.js';

/** Hook timeout is 3300 s; leave a margin so we exit 0 before the harness kills us. */
export const LISTEN_TIMEOUT_MS = 3300_000;
const EXIT_MARGIN_MS = 60_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

export interface ListenOpts {
  /** Override the run length (tests). */
  runMs?: number;
  /** Override the error backoff floor (tests). */
  backoffMinMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ListenerFile {
  pid: number;
  generation: number;
  startedAt: number;
}

function listenerFile(ctx: HookCtx, sid: string): string {
  return path.join(ctx.paths.state, `listener-${safeSid(sid)}.json`);
}

/** Claim the per-session listener slot. False when another live listener holds it. */
export function claimListener(ctx: HookCtx, sid: string): ListenerFile | undefined {
  const file = listenerFile(ctx, sid);
  const cur = readJson<ListenerFile>(file);
  if (cur && cur.pid !== process.pid && pidAlive(cur.pid) && ctx.now() - cur.startedAt < LISTEN_TIMEOUT_MS) {
    return undefined;
  }
  const mine: ListenerFile = { pid: process.pid, generation: (cur?.generation ?? 0) + 1, startedAt: ctx.now() };
  writeJsonAtomic(file, mine);
  // Re-read: a concurrent claimer may have won the rename race.
  const after = readJson<ListenerFile>(file);
  return after && after.pid === mine.pid && after.generation === mine.generation ? mine : undefined;
}

function release(ctx: HookCtx, sid: string, mine: ListenerFile): void {
  const file = listenerFile(ctx, sid);
  const cur = readJson<ListenerFile>(file);
  if (cur && cur.pid === mine.pid && cur.generation === mine.generation) fs.rmSync(file, { force: true });
}

function pulseBearer(ctx: HookCtx): string | undefined {
  const b = readBrief(ctx.paths);
  const pt = b?.pulseToken;
  if (pt && Date.parse(pt.expiresAt) - ctx.now() > 60_000) return pt.token;
  return ctx.config.token;
}

export function listen(ctx: HookCtx, o: ListenOpts = {}): Promise<HookResult> {
  return failOpen(ctx, 'listen', async () => {
    const sid = typeof ctx.input.session_id === 'string' ? ctx.input.session_id : undefined;
    if (!sid || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sid)) return OK;
    if (!ctx.config.token || ctx.config.wakeOnDm === 'off' || ctx.config.headless) return OK;
    const mine = claimListener(ctx, sid);
    if (!mine) return OK;
    const wait = o.sleep ?? sleep;
    const endAt = ctx.now() + (o.runMs ?? LISTEN_TIMEOUT_MS - EXIT_MARGIN_MS);
    const backoffMin = o.backoffMinMs ?? BACKOFF_MIN_MS;
    let backoff = backoffMin;
    try {
      while (ctx.now() < endAt) {
        // Superseded by a newer listener for this session → step aside.
        const cur = readJson<ListenerFile>(listenerFile(ctx, sid));
        if (cur && (cur.pid !== mine.pid || cur.generation !== mine.generation)) return OK;
        const left = endAt - ctx.now();
        const waitS = Math.min(PULSE_MAX_WAIT_S, Math.floor((left - 2_000) / 1000));
        if (waitS < 1) break;
        const q = new URLSearchParams({ wait: String(waitS), sessionId: sid });
        const cursor = readPulse(ctx.paths).cursor;
        if (cursor) q.set('cursor', cursor);
        let delay = 0;
        try {
          const res = await httpJson(ctx.fetch, 'GET', `${ctx.config.apiUrl}/api/v1/pulse?${q}`, {
            token: pulseBearer(ctx),
            timeoutMs: waitS * 1000 + 10_000,
            headers: { 'x-paceline-session': sid },
          });
          if (res.status >= 200 && res.status < 300 && res.body && typeof res.body === 'object') {
            backoff = backoffMin;
            const r = res.body as Record<string, unknown>;
            const unread = UnreadCounts.safeParse(r.unread);
            const ks = KillSwitches.safeParse(r.killSwitches);
            const newCursor = typeof r.cursor === 'string' && /^[A-Za-z0-9_\-.~=]{1,512}$/.test(r.cursor) ? r.cursor : undefined;
            updatePulse(ctx.paths, { ...(newCursor ? { cursor: newCursor } : {}), ...(unread.success ? { unread: unread.data } : {}) }, ctx.now());
            const wake = r.wake as { targetSessionId?: unknown; pointer?: unknown } | undefined;
            const pushOk = ks.success && !ks.data.pushPaths;
            if (wake && wake.targetSessionId === sid && pushOk) {
              const valid = Pointer.safeParse(wake.pointer);
              const text = (valid.success ? renderOne(valid.data) : null) ?? fallbackText();
              return { exitCode: 2, stderr: text };
            }
            const ra = typeof r.retryAfterS === 'number' && r.retryAfterS > 0 ? Math.min(3600, r.retryAfterS) : 0;
            delay = ra * 1000;
          } else if (res.status === 401 || res.status === 403) {
            return OK; // token revoked: SessionStart reports it to the human
          } else {
            delay = res.retryAfterS ? res.retryAfterS * 1000 : backoff;
            backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
          }
        } catch {
          delay = backoff;
          backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
        }
        if (delay > 0) {
          if (ctx.now() + delay >= endAt) break;
          await wait(delay);
        }
      }
      return OK;
    } finally {
      release(ctx, sid, mine);
    }
  });
}
