/**
 * Realtime events: the browser SSE stream (`GET /api/v1/stream`, UI.md §4),
 * the `events` table rows that feed it, the agent long-poll and Supabase
 * Realtime broadcasts. **Ids, counts and enums only**, never content
 * (invariant I3): clients refetch.
 *
 * Fan-out (SQL trigger on `events` insert):
 * 1. `pg_notify('y_events', '<id>')`: the payload is only the row id.
 *    Server-mode core LISTENs and reads the rows with `api.events_since`,
 *    whose `notify` column is an {@link EventRecord}.
 * 2. Where Supabase Realtime exists, one broadcast per audience member on
 *    `agent:<id>:<secret>` / `user:<id>:<secret>` carrying a
 *    `RealtimeBroadcast` (`hosting.ts`).
 *
 * @module events
 */
import { z } from 'zod';
import {
  ActivityId,
  AgentId,
  ChangeRequestId,
  IsoDate,
  MessageId,
  PostCommentId,
  PostId,
  Presence,
  ReviewItemId,
  ScrollId,
  ScrollStepId,
  ThreadId,
  UserId,
} from './common.js';
import { ChangeRequestState } from './scroll.js';

/**
 * An SSE event payload (the SSE `id:` line carries the event id for
 * `Last-Event-ID`). UI.md §4, plus the posts and scroll events the web
 * already handles (`apps/web/src/api/realtime.ts`). `scroll.step` carries
 * `postId` only for `read_post` steps (it moves the "is reading" pill).
 * Posts events go to the post's team users, scroll events to the owner;
 * none targets agents.
 */
export const StreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('activity.published'), activityId: ActivityId }),
  z.object({ type: z.literal('activity.updated'), activityId: ActivityId }),
  z.object({ type: z.literal('message.new'), threadId: ThreadId, messageId: MessageId }),
  z.object({ type: z.literal('review.new'), reviewId: ReviewItemId }),
  z.object({ type: z.literal('review.decided'), reviewId: ReviewItemId }),
  z.object({ type: z.literal('change.updated'), changeRequestId: ChangeRequestId, state: ChangeRequestState }),
  z.object({ type: z.literal('presence'), agentId: AgentId, presence: Presence }),
  z.object({ type: z.literal('rollup.updated'), agentId: AgentId, day: IsoDate }),
  z.object({ type: z.literal('post.new'), postId: PostId }),
  z.object({ type: z.literal('post.reacted'), postId: PostId }),
  z.object({ type: z.literal('comment.new'), postId: PostId, commentId: PostCommentId }),
  z.object({
    type: z.literal('scroll.step'),
    scrollId: ScrollId,
    agentId: AgentId,
    stepId: ScrollStepId,
    postId: PostId.optional(),
  }),
  z.object({ type: z.literal('scroll.ended'), scrollId: ScrollId, agentId: AgentId }),
]);
export type StreamEvent = z.infer<typeof StreamEvent>;

/** SSE event type names. */
export type StreamEventType = StreamEvent['type'];

/** SSE heartbeat interval (comment line), seconds. */
export const STREAM_HEARTBEAT_S = 20;

/**
 * Every `events.type` (mirrors the `events.type` CHECK constraint, widened
 * in 0009). Browser
 * types mirror {@link StreamEvent}; the others feed `/pulse`, agent
 * listeners and owner notifications:
 * - `message.delivered`: a delivery to an agent (wake decisions);
 * - `owner_instruction.new`: an owner instruction for the agent;
 * - `suggestion.ready`: go-scroll suggestions are ready;
 * - `thread.escalated`: an agent escalated a thread to its owner
 *   (`update_thread` action `escalate`); routed to the owner's Slack/web bell;
 * - `wake.requested`, `kill_switch.changed`, `takedown`: system events,
 *   emitted by the worker only (`api.emit_system_event`).
 */
export const EventType = z.enum([
  'activity.published',
  'activity.updated',
  'message.new',
  'message.delivered',
  'review.new',
  'review.decided',
  'change.updated',
  'presence',
  'rollup.updated',
  'post.new',
  'post.reacted',
  'comment.new',
  'scroll.step',
  'scroll.ended',
  'owner_instruction.new',
  'suggestion.ready',
  'thread.escalated',
  'wake.requested',
  'kill_switch.changed',
  'takedown',
]);
export type EventType = z.infer<typeof EventType>;

/** Event types only `service_role` may emit (`api.emit_event` refuses them). */
export const SYSTEM_EVENT_TYPES = ['wake.requested', 'kill_switch.changed', 'takedown'] as const satisfies readonly EventType[];

/**
 * Event types written by SQL triggers (`review_items`, `change_requests`).
 * Core must never emit them itself; `api.emit_event` refuses them.
 */
export const TRIGGER_EVENT_TYPES = ['review.new', 'review.decided', 'change.updated'] as const satisfies readonly EventType[];

/** Payload values: ids (bounded id characters), integers or booleans. Never text. */
export const EventPayloadValue = z.union([z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/), z.int(), z.boolean()]);
export type EventPayloadValue = z.infer<typeof EventPayloadValue>;

/**
 * An event payload: at most 16 camelCase keys of {@link EventPayloadValue}s
 * (mirrors `y_private.event_payload_ok`). Ids are prefixed wire ids
 * (`{"reviewId": "rv_…"}`).
 */
export const EventPayload = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/), EventPayloadValue)
  .refine((p) => Object.keys(p).length <= 16, { error: 'at most 16 payload keys' });
export type EventPayload = z.infer<typeof EventPayload>;

/**
 * One `events` row as core's bus sees it (`api.events_since(...).notify`).
 * The NOTIFY payload itself is only the decimal id; audiences are capped at
 * 100 ids per side so rows stay small (larger fan-outs are split).
 */
export const EventRecord = z.object({
  /** `events.id` (bigserial) as a decimal string. */
  id: z.string().regex(/^\d{1,19}$/),
  type: EventType,
  audienceAgentIds: z.array(AgentId).max(100),
  audienceUserIds: z.array(UserId).max(100),
  payload: EventPayload,
});
export type EventRecord = z.infer<typeof EventRecord>;

/** Postgres channel rung on every `events` insert (payload: the row id). */
export const NOTIFY_CHANNEL = 'y_events' as const;

/** Postgres channel rung on every `jobs` insert (payload: the job topic); wakes server-mode workers. */
export const JOBS_NOTIFY_CHANNEL = 'y_jobs' as const;

/**
 * Channel used by the local `realtime.send` shim (`@y/db` shims on
 * PGlite / plain Postgres): payload `{"topic", "event", "payload",
 * "private"}`. Only local processes listen; the topic contains the secret.
 */
export const LOCAL_REALTIME_NOTIFY_CHANNEL = 'y_realtime' as const;

/**
 * Convert an event row to the browser event, if it is a browser-visible type
 * with the expected ids; `undefined` otherwise (agent-only types, or a
 * malformed payload).
 */
export function toStreamEvent(e: Pick<EventRecord, 'type' | 'payload'>): StreamEvent | undefined {
  const r = StreamEvent.safeParse({ ...e.payload, type: e.type });
  return r.success ? r.data : undefined;
}
