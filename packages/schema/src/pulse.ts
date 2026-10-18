/**
 * `GET /api/v1/pulse?cursor=&wait=`: the agent long-poll used by the
 * asyncRewake listener and the uploader (PLAN §2 Realtime). Ids and counts
 * only; content is fetched through MCP tools.
 *
 * @module pulse
 */
import { z } from 'zod';
import { ChangeRequestId, Count, CursorString, HarnessSessionId, KillSwitches } from './common.js';
import { Pointer } from './pointers.js';

/** Longest server-side hold of a long-poll, seconds. */
export const PULSE_MAX_WAIT_S = 25;

/**
 * While a turn is in progress, a listener reports `active=1` at least this
 * often (seconds), whatever its transport; core's live window
 * (packages/domain PRESENCE_LIVE_WINDOW_MS) covers two missed reports.
 */
export const PULSE_ACTIVE_EVERY_S = 60;

/** Query string (values arrive as strings and are coerced). */
export const PulseQuery = z.object({
  cursor: CursorString.optional(),
  wait: z.coerce.number().int().min(0).max(PULSE_MAX_WAIT_S).default(20),
  /** The listening session, so a targeted wake can be addressed to it. */
  sessionId: HarnessSessionId.optional(),
  /**
   * Turn state of that session (presence): `1` while a turn is in progress
   * (prompt submitted, Stop not yet fired), `0` when idle. Older plugins omit
   * it; core then falls back to recent ingests.
   */
  active: z.enum(['0', '1']).optional(),
});
export type PulseQuery = z.infer<typeof PulseQuery>;

/**
 * Unread counts by kind. `posts` = published team posts by other agents not
 * yet exposed to this agent (capped; a count only, I3). It defaults to 0 so
 * older servers and saved plugin state still parse.
 */
export const UnreadCounts = z.object({
  dm: Count,
  ownerInstructions: Count,
  reviews: Count,
  suggestions: Count,
  posts: Count.default(0),
});
export type UnreadCounts = z.infer<typeof UnreadCounts>;

/**
 * Long-poll response. Returns early when anything changes, else after
 * `wait` seconds with the same cursor. `wake` is set only when the server's
 * session lease picked `targetSessionId` for a wake; the listener for that
 * session exits 2 with the rendered pointer, every other listener ignores it.
 */
export const PulseResponse = z.object({
  cursor: CursorString,
  unread: UnreadCounts,
  wake: z
    .object({
      targetSessionId: HarnessSessionId,
      pointer: Pointer,
    })
    .optional(),
  approvedChanges: z.array(z.object({ changeRequestId: ChangeRequestId })).max(20),
  killSwitches: KillSwitches,
  /** Back off before polling again (rate limiting / maintenance). */
  retryAfterS: z.int().min(0).max(3600).optional(),
});
export type PulseResponse = z.infer<typeof PulseResponse>;

/** Acknowledge a wake (the woken session confirms it got it; otherwise the next session is tried after 30 s). */
export const WakeAck = z.object({
  sessionId: HarnessSessionId,
  cursor: CursorString,
});
export type WakeAck = z.infer<typeof WakeAck>;
