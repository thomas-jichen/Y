/**
 * Presence windows (PLAN §9 Reachability). The rule itself lives in one place,
 * the SQL function `y_private.derive_presence` (supabase/migrations/0010_presence.sql):
 *
 * - `live`: a listener reported a turn in progress (`/api/v1/pulse?active=1`)
 *   within {@link PRESENCE_LIVE_WINDOW_MS}; or, for sessions whose listener
 *   does not report turns (older plugins), an ingest chunk within
 *   {@link PRESENCE_INGEST_LIVE_WINDOW_MS} on a session that has not ended;
 * - `listening` / `listening_needs_approval`: otherwise a session lease
 *   heartbeat (each `/api/v1/pulse` poll) within the listening window;
 * - `away`: neither.
 *
 * Core passes these windows to `api.refresh_agent_presence`; the SQL defaults
 * match the long-poll values.
 */
import { PULSE_ACTIVE_EVERY_S } from '@y/schema';
import { LEASE_STALE_MS } from './lease.js';

/**
 * A turn counts as live this long after the last `active=1` pulse. Listeners
 * report at least every PULSE_ACTIVE_EVERY_S (60 s) during a turn in every
 * transport, so this is two missed reports plus 30 s of slack.
 */
export const PRESENCE_LIVE_WINDOW_MS = 2 * PULSE_ACTIVE_EVERY_S * 1000 + 30_000;

/**
 * Fallback for plugins that do not report turns: a session counts as live for
 * 10 min after its last ingest (the Stop hook uploads one per turn).
 */
export const PRESENCE_INGEST_LIVE_WINDOW_MS = 10 * 60_000;

/**
 * Long-poll listeners re-poll at least every 25 s, so a lease older than
 * {@link LEASE_STALE_MS} (two missed polls) is not listening. Same window as
 * wake targeting: `listening` means a wake can reach the agent.
 */
export const PRESENCE_LISTENING_WINDOW_MS = LEASE_STALE_MS;

/**
 * Doorbell listeners (core hands out a Supabase Realtime channel) poll only
 * when the broadcast rings, plus a safety poll every 5 min (plugin
 * SAFETY_POLL_MS), so an idle one heartbeats every 5 min: two safety polls
 * plus 30 s of slack.
 */
export const PRESENCE_LISTENING_WINDOW_DOORBELL_MS = 2 * 300_000 + 30_000;

/** The presence sweep (decay to away) runs this often. */
export const PRESENCE_SWEEP_EVERY_MS = 60_000;

export interface PresenceWindows {
  liveMs: number;
  ingestLiveMs: number;
  listeningMs: number;
}

/**
 * Presence windows for the listener transport core hands out: `doorbell` when
 * agents get a Supabase Realtime channel (core knows the project URL and
 * publishable key, whatever its run mode), else long-poll.
 */
export function presenceWindows(opts: { doorbell: boolean }): PresenceWindows {
  return {
    liveMs: PRESENCE_LIVE_WINDOW_MS,
    ingestLiveMs: PRESENCE_INGEST_LIVE_WINDOW_MS,
    listeningMs: opts.doorbell ? PRESENCE_LISTENING_WINDOW_DOORBELL_MS : PRESENCE_LISTENING_WINDOW_MS,
  };
}

/**
 * Next run of a recurring job on a cron-ticked queue: aim 5 s before a
 * multiple of `everyMs` at least half a period away, so the per-minute tick at
 * that boundary already counts it as due (a plain `now + everyMs` lands just
 * after the tick and waits one more). `slot` names the boundary (dedupe key).
 */
export function recurringSlot(nowMs: number, everyMs: number): { slot: number; runAfterMs: number } {
  const slot = Math.floor((nowMs + everyMs / 2) / everyMs) + 1;
  return { slot, runAfterMs: Math.max(1, slot * everyMs - nowMs - 5_000) };
}
