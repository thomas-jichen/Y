/**
 * The asyncRewake listener and its Stop-time marker. Design and reasoning in
 * plugins/claude-code/README.md ("Wake design"); the short version, from the
 * S1 spike:
 *
 * - **Armed from SessionStart and UserPromptSubmit only** (asyncRewake,
 *   timeout 3300 s). Never from Stop: Stop fires after every turn, including
 *   the turns a wake produces, so a Stop-armed listener re-arms off its own
 *   wakes and its timers accumulate (13 self-triggered turns in 5 minutes).
 * - **Exactly one live listener per session** (`state/listener-<sid>.json`,
 *   pid + generation). A second spawn exits 0 at once; an older live one
 *   steps aside when it sees a newer generation.
 * - **Exit 2 only on a targeted wake with real news** (the wake names this
 *   session and the matching unread count is > 0), and only within the local
 *   wake budget (wake-budget.ts). Over budget: exit 0 and park the pointer
 *   for UserPromptSubmit.
 * - Stop runs `listen.mjs mark` synchronously: no network, no spawn; it only
 *   records `state/needs-listener-<sid>.json` when no listener is live, so
 *   the gap is visible (doctor, logs) until the next UserPromptSubmit arms one.
 *
 * Presence: each pulse carries `active=1` while a turn is in progress
 * (turn.ts: UserPromptSubmit's spawn writes the marker, Stop's `mark` and
 * SessionEnd remove it) and `active=0` otherwise, at least every
 * PULSE_ACTIVE_EVERY_S during a turn in every transport. A UserPromptSubmit
 * spawn that finds a live listener sends one `/pulse?wait=0&active=1` before
 * exiting, so the turn shows at once. A listener whose session ended
 * (`ended-<sid>.json`) exits.
 *
 * Transport: in server mode `GET /api/v1/pulse?cursor&wait` long-polls. When
 * the cached brief carries a Supabase realtime channel (serverless core), the
 * listener waits on the broadcast doorbell and calls `/pulse?wait=0` when it
 * rings, plus a safety poll every 5 minutes; without a global WebSocket it
 * polls every 60 s. Backoff 5 s → 60 s on errors; exits 0 near its timeout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KillSwitches } from '@y/schema/common';
import { Pointer } from '@y/schema/pointers';
import { PULSE_ACTIVE_EVERY_S, PULSE_MAX_WAIT_S, UnreadCounts } from '@y/schema/pulse';
import { failOpen, OK, type HookCtx, type HookResult } from './context.js';
import { Doorbell, globalWebSocket, type SupabaseChannel, type WsCtor } from './realtime.js';
import { httpJson, logLine, pidAlive, readJson, safeSid, sleep, writeJsonAtomic } from './runtime.js';
import { fallbackText, readBrief, readPulse, renderOne, updatePulse } from './state.js';
import { clearSessionEnded, endTurn, sessionEnded, startTurn, turnActive } from './turn.js';
import { parkPendingWake, takeWake } from './wake-budget.js';

/** Hook timeout is 3300 s; leave a margin so we exit 0 before the harness kills us. */
export const LISTEN_TIMEOUT_MS = 3300_000;
const EXIT_MARGIN_MS = 60_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
/** Serverless: poll even without a ring this often (missed broadcasts, reconnects). */
export const SAFETY_POLL_MS = 300_000;
/** Serverless without WebSocket support: plain polling interval. */
export const SLOW_POLL_MS = 60_000;
/** During a turn, report `active=1` at least this often (doorbell mode would otherwise wait 5 min). */
export const ACTIVE_POLL_MS = PULSE_ACTIVE_EVERY_S * 1000;
/** Doorbell waits are sliced this fine so a turn that starts mid-wait is reported promptly. */
const TURN_CHECK_MS = 15_000;

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface ListenOpts {
  /** Override the run length (tests). */
  runMs?: number;
  /** Override the error backoff floor (tests). */
  backoffMinMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** WebSocket constructor for the serverless doorbell; `null` disables it. Default: the global one. */
  webSocket?: WsCtor | null;
  /** Override the serverless safety-poll interval (tests). */
  safetyPollMs?: number;
  /** Override how often a doorbell wait re-checks the turn marker (tests). */
  turnCheckMs?: number;
}

interface ListenerFile {
  pid: number;
  generation: number;
  startedAt: number;
}

function listenerFile(ctx: HookCtx, sid: string): string {
  return path.join(ctx.paths.state, `listener-${safeSid(sid)}.json`);
}

function needsListenerFile(ctx: HookCtx, sid: string): string {
  return path.join(ctx.paths.state, `needs-listener-${safeSid(sid)}.json`);
}

function sessionId(ctx: HookCtx): string | undefined {
  const sid = typeof ctx.input.session_id === 'string' ? ctx.input.session_id : undefined;
  return sid && SID_RE.test(sid) ? sid : undefined;
}

/** True when another process holds a live, unexpired listener slot for this session. */
export function liveListener(ctx: HookCtx, sid: string): boolean {
  const cur = readJson<ListenerFile>(listenerFile(ctx, sid));
  return !!cur && cur.pid !== process.pid && pidAlive(cur.pid) && ctx.now() - cur.startedAt < LISTEN_TIMEOUT_MS;
}

/** Claim the per-session listener slot. Undefined when another live listener holds it. */
export function claimListener(ctx: HookCtx, sid: string): ListenerFile | undefined {
  if (liveListener(ctx, sid)) return undefined;
  const file = listenerFile(ctx, sid);
  const cur = readJson<ListenerFile>(file);
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

function superseded(ctx: HookCtx, sid: string, mine: ListenerFile): boolean {
  const cur = readJson<ListenerFile>(listenerFile(ctx, sid));
  return !!cur && (cur.pid !== mine.pid || cur.generation !== mine.generation);
}

function pulseBearer(ctx: HookCtx): string | undefined {
  const b = readBrief(ctx.paths);
  const pt = b?.pulseToken;
  if (pt && Date.parse(pt.expiresAt) - ctx.now() > 60_000) return pt.token;
  return ctx.config.token;
}

function listeningEnabled(ctx: HookCtx): boolean {
  return !!ctx.config.token && ctx.config.wakeOnDm !== 'off' && !ctx.config.headless;
}

function transcriptPath(ctx: HookCtx): string | undefined {
  const t = ctx.input.transcript_path;
  return typeof t === 'string' && t.length > 0 && t.length < 4096 ? t : undefined;
}

function isTurnActive(ctx: HookCtx, sid: string): boolean {
  return turnActive(ctx.paths, sid, ctx.now(), transcriptPath(ctx));
}

/** One immediate turn report (no cursor: it consumes no events, so it can't swallow a wake). */
async function reportTurn(ctx: HookCtx, sid: string): Promise<void> {
  const q = new URLSearchParams({ wait: '0', sessionId: sid, active: '1' });
  try {
    await httpJson(ctx.fetch, 'GET', `${ctx.config.apiUrl}/api/v1/pulse?${q}`, {
      token: pulseBearer(ctx),
      timeoutMs: 10_000,
      headers: { 'x-y-session': sid },
    });
  } catch {
    /* best effort: the live listener reports the turn on its next poll */
  }
}

/**
 * Stop (synchronous, local only, no output): record that this session has no
 * live listener. Never spawns or re-arms anything (S1 §5).
 */
export function markNeedsListener(ctx: HookCtx): Promise<HookResult> {
  return failOpen(ctx, 'listen-mark', async () => {
    const sid = sessionId(ctx);
    if (!sid) return OK;
    endTurn(ctx.paths, sid); // the turn is over (presence: no longer live)
    if (!listeningEnabled(ctx)) return OK;
    const file = needsListenerFile(ctx, sid);
    if (liveListener(ctx, sid)) {
      fs.rmSync(file, { force: true });
      return OK;
    }
    if (!readJson(file)) writeJsonAtomic(file, { since: ctx.now() });
    return OK;
  });
}

/** Real news: the matching unread count for the wake's template is above zero. */
function isRealNews(pointer: Pointer | undefined, unread: UnreadCounts | undefined): boolean {
  if (!unread) return false;
  if (pointer?.template_id === 'P1') return unread.dm > 0;
  if (pointer?.template_id === 'P4') return unread.ownerInstructions > 0;
  return unread.dm + unread.ownerInstructions > 0;
}

type Mode = { kind: 'longpoll' } | { kind: 'doorbell'; ch: SupabaseChannel; Ws: WsCtor } | { kind: 'slowpoll' };

function pickMode(ctx: HookCtx, o: ListenOpts): Mode {
  const rt = readBrief(ctx.paths)?.realtime;
  if (!rt || rt.provider !== 'supabase') return { kind: 'longpoll' };
  const Ws = o.webSocket === null ? undefined : (o.webSocket ?? globalWebSocket());
  return Ws ? { kind: 'doorbell', ch: rt, Ws } : { kind: 'slowpoll' };
}

export function listen(ctx: HookCtx, o: ListenOpts = {}): Promise<HookResult> {
  return failOpen(ctx, 'listen', async () => {
    const sid = sessionId(ctx);
    if (!sid || !listeningEnabled(ctx)) return OK;
    // Spawned by SessionStart or UserPromptSubmit: the session is alive (again, after a resume).
    clearSessionEnded(ctx.paths, sid);
    if (ctx.input.hook_event_name === 'UserPromptSubmit') startTurn(ctx.paths, sid, ctx.now());
    const mine = claimListener(ctx, sid);
    if (!mine) {
      // Another listener is live, maybe mid-wait for minutes: report the new turn now.
      if (isTurnActive(ctx, sid)) await reportTurn(ctx, sid);
      return OK;
    }
    fs.rmSync(needsListenerFile(ctx, sid), { force: true });
    const wait = o.sleep ?? sleep;
    const endAt = ctx.now() + (o.runMs ?? LISTEN_TIMEOUT_MS - EXIT_MARGIN_MS);
    const backoffMin = o.backoffMinMs ?? BACKOFF_MIN_MS;
    const safetyMs = o.safetyPollMs ?? SAFETY_POLL_MS;
    const turnCheckMs = o.turnCheckMs ?? TURN_CHECK_MS;
    const mode = pickMode(ctx, o);
    let bell: Doorbell | undefined;
    const openBell = () => {
      if (mode.kind !== 'doorbell') return;
      bell?.close();
      bell = new Doorbell(mode.ch, mode.Ws);
      bell.start();
    };
    openBell();
    let backoff = backoffMin;
    let bellBackoff = backoffMin;
    try {
      while (ctx.now() < endAt) {
        if (superseded(ctx, sid, mine)) return OK; // a newer listener for this session → step aside
        if (sessionEnded(ctx.paths, sid)) {
          clearSessionEnded(ctx.paths, sid); // SessionEnd ran: stop heartbeating a session that's gone
          return OK;
        }
        const left = endAt - ctx.now();
        const waitS = mode.kind === 'longpoll' ? Math.min(PULSE_MAX_WAIT_S, Math.floor((left - 2_000) / 1000)) : 0;
        if (mode.kind === 'longpoll' && waitS < 1) break;
        const active = isTurnActive(ctx, sid);
        const polledAt = ctx.now();
        const q = new URLSearchParams({ wait: String(waitS), sessionId: sid, active: active ? '1' : '0' });
        const cursor = readPulse(ctx.paths).cursor;
        if (cursor) q.set('cursor', cursor);
        let delay = 0;
        let ok = false;
        try {
          const res = await httpJson(ctx.fetch, 'GET', `${ctx.config.apiUrl}/api/v1/pulse?${q}`, {
            token: pulseBearer(ctx),
            timeoutMs: waitS * 1000 + 10_000,
            headers: { 'x-y-session': sid },
          });
          if (res.status >= 200 && res.status < 300 && res.body && typeof res.body === 'object') {
            ok = true;
            backoff = backoffMin;
            const r = res.body as Record<string, unknown>;
            const unread = UnreadCounts.safeParse(r.unread);
            const ks = KillSwitches.safeParse(r.killSwitches);
            const newCursor = typeof r.cursor === 'string' && /^[A-Za-z0-9_\-.~=]{1,512}$/.test(r.cursor) ? r.cursor : undefined;
            updatePulse(ctx.paths, { ...(newCursor ? { cursor: newCursor } : {}), ...(unread.success ? { unread: unread.data } : {}) }, ctx.now());
            const wake = r.wake as { targetSessionId?: unknown; pointer?: unknown } | undefined;
            const pushOk = ks.success && !ks.data.pushPaths;
            // A newer listener took the slot while this poll was in flight: it owns the wake.
            if (superseded(ctx, sid, mine)) return OK;
            if (wake && wake.targetSessionId === sid && pushOk) {
              const valid = Pointer.safeParse(wake.pointer);
              const pointer = valid.success ? valid.data : undefined;
              if (isRealNews(pointer, unread.success ? unread.data : undefined)) {
                const budget = takeWake(ctx.paths, ctx.now());
                if (!budget.allow) {
                  if (pointer) parkPendingWake(ctx.paths, sid, pointer, ctx.now());
                  logLine(ctx.config.dataDir, 'listen', `wake deferred to next prompt: over budget (${budget.reason})`);
                  return OK;
                }
                const text = (pointer ? renderOne(pointer) : null) ?? fallbackText();
                return { exitCode: 2, stderr: text };
              }
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
        if (ok && mode.kind === 'slowpoll') delay = Math.max(delay, SLOW_POLL_MS);
        if (ok && mode.kind === 'doorbell') {
          if (delay > 0) {
            if (ctx.now() + delay >= endAt) break;
            await wait(delay);
          }
          if (bell?.closed) {
            // Reconnect with its own backoff (5 s → 60 s), so a dead socket can't turn into fast polling.
            if (ctx.now() + bellBackoff >= endAt) break;
            await wait(bellBackoff);
            bellBackoff = Math.min(BACKOFF_MAX_MS, bellBackoff * 2);
            openBell();
          }
          // Wait for a ring, the safety poll, or (during a turn) the next turn report; in slices, so a
          // turn that starts or ends mid-wait is reported within TURN_CHECK_MS.
          let r: Awaited<ReturnType<Doorbell['wait']>> = 'timeout';
          for (;;) {
            const nowActive = isTurnActive(ctx, sid);
            if (nowActive !== active) break; // a turn started or ended since the poll: report it now
            const dueAt = polledAt + (nowActive ? Math.min(safetyMs, ACTIVE_POLL_MS) : safetyMs);
            const until = Math.min(dueAt, endAt - 2_000);
            if (ctx.now() >= until) break;
            r = await bell!.wait(Math.max(0, Math.min(turnCheckMs, until - ctx.now())));
            if (r !== 'timeout') break;
          }
          if (r === 'ring') bellBackoff = backoffMin;
          if (r === 'timeout' && endAt - ctx.now() <= 2_000) break;
          continue;
        }
        if (delay > 0) {
          if (ctx.now() + delay >= endAt) break;
          await wait(delay);
        }
      }
      return OK;
    } finally {
      bell?.close();
      release(ctx, sid, mine);
    }
  });
}
