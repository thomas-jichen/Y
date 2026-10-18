/**
 * Zero-cost hosting contracts (decided after PLAN.md; they override it where
 * they conflict):
 *
 * - **Hosting modes.** `apps/core` runs the same code in `server` mode
 *   (long-running Node: local dev, containers) with an in-process job loop
 *   and push bus, and in `serverless` mode (Vercel Hobby) where jobs are
 *   drained by `after()`/`waitUntil` on requests plus a Supabase pg_cron tick
 *   that calls {@link JOBS_TICK_PATH} every minute.
 * - **Realtime.** Every `events` row fans out through Supabase Realtime
 *   BROADCAST in production, on the secret topics
 *   `agent:<agent_id>:<secret>` and `user:<user_id>:<secret>`
 *   ({@link RealtimeChannel}); locally through `pg_notify`. Broadcast
 *   payloads are {@link RealtimeBroadcast}: ids, counts and enums only (I3).
 * - **Embeddings.** 384 dimensions everywhere ({@link EMBEDDING_DIMS}),
 *   produced by Supabase's built-in `gte-small` in the `embed` Edge Function
 *   ({@link EmbedRequest} / {@link EmbedResponse}); tests use the mock
 *   embedder at the same width.
 *
 * @module hosting
 */
import { z } from 'zod';
import { Count } from './common.js';
import { EventPayload, EventType } from './events.js';

/* ============================================================ modes */

/**
 * How core runs:
 * - `server`: one long-running Node process (local dev, any container). Jobs
 *   run in an in-process loop woken by `LISTEN y_jobs`; pushes go
 *   through an in-process bus fed by `LISTEN y_events` (SSE for
 *   browsers, `/api/v1/pulse` long-poll for agents).
 * - `serverless`: stateless Vercel functions. Jobs are drained after
 *   responses (`after()`/`waitUntil`) and by the pg_cron tick; pushes go
 *   through Supabase Realtime broadcast only (no SSE, no long-poll holds).
 */
export const HostingMode = z.enum(['server', 'serverless']);
export type HostingMode = z.infer<typeof HostingMode>;

/* ======================================================== embeddings */

/** Embedding width: `vector(384)` columns, gte-small, and the mock embedder. */
export const EMBEDDING_DIMS = 384 as const;

/** The production embedding model (Supabase built-in inference). */
export const EMBEDDING_MODEL = 'gte-small' as const;

/** Path of the embed Edge Function under the Supabase project URL. */
export const EMBED_FUNCTION_PATH = '/functions/v1/embed' as const;

/** Header carrying `Y_EMBED_SECRET` (the function is deployed with `--no-verify-jwt`). */
export const EMBED_SECRET_HEADER = 'x-y-embed-secret' as const;

/** Most inputs per embed request. */
export const EMBED_MAX_INPUTS = 32;

/** Most characters per embed input (gte-small reads ~512 tokens; the model truncates the rest). */
export const EMBED_MAX_INPUT_CHARS = 8000;

const EmbedInputText = z.string().min(1).max(EMBED_MAX_INPUT_CHARS);

/**
 * `POST <SUPABASE_URL>/functions/v1/embed` body. Exactly one key. Inputs are
 * never logged or echoed by the function (embedded text can be team-private).
 */
export const EmbedRequest = z.strictObject({
  input: z.union([EmbedInputText, z.array(EmbedInputText).min(1).max(EMBED_MAX_INPUTS)]),
});
export type EmbedRequest = z.infer<typeof EmbedRequest>;

/**
 * Embed response: one mean-pooled, L2-normalized vector per input, in input
 * order. Errors use the `ErrorBody` shape (`UNAUTHORIZED` 401, `VALIDATION`
 * 400/413, `INTERNAL` 500/503).
 */
export const EmbedResponse = z.object({
  model: z.literal(EMBEDDING_MODEL),
  dims: z.literal(EMBEDDING_DIMS),
  embeddings: z.array(z.array(z.number()).length(EMBEDDING_DIMS)).min(1).max(EMBED_MAX_INPUTS),
});
export type EmbedResponse = z.infer<typeof EmbedResponse>;

/* ========================================================== realtime */

/** Who a realtime channel belongs to. */
export const RealtimeOwnerKind = z.enum(['agent', 'user']);
export type RealtimeOwnerKind = z.infer<typeof RealtimeOwnerKind>;

/** A channel secret (`realtime_channels.secret`): 64 lowercase hex characters. */
export const ChannelSecret = z.string().regex(/^[a-f0-9]{64}$/, { error: 'expected a 64-char hex channel secret' });
export type ChannelSecret = z.infer<typeof ChannelSecret>;

const TOPIC_RE = /^(agent|user):([A-Za-z0-9][A-Za-z0-9_-]{0,63}):([a-f0-9]{64})$/;

/**
 * A broadcast topic: `agent:<agent_id>:<secret>` or `user:<user_id>:<secret>`
 * (exactly what the events trigger builds from `realtime_channels`). The
 * secret makes a public channel unguessable; treat the topic as a credential
 * and never log it.
 */
export const RealtimeTopic = z.string().regex(TOPIC_RE, { error: 'expected agent|user:<id>:<64-hex secret>' });
export type RealtimeTopic = z.infer<typeof RealtimeTopic>;

/** Build a topic. @throws TypeError on an invalid owner id or secret. */
export function realtimeTopic(ownerKind: RealtimeOwnerKind, ownerId: string, secret: string): RealtimeTopic {
  const topic = `${ownerKind}:${ownerId}:${secret}`;
  if (!TOPIC_RE.test(topic)) throw new TypeError('realtimeTopic: invalid owner id or secret');
  return topic;
}

/** Split a topic into its parts; `undefined` if it is not a valid topic. */
export function parseRealtimeTopic(
  topic: string,
): { ownerKind: RealtimeOwnerKind; ownerId: string; secret: ChannelSecret } | undefined {
  const m = TOPIC_RE.exec(topic);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return undefined;
  return { ownerKind: m[1] as RealtimeOwnerKind, ownerId: m[2], secret: m[3] };
}

/**
 * The caller's realtime channel, returned in `AgentBrief.realtime` (the
 * agent's channel) and `Me.realtime` (the user's channel). Read from
 * `realtime_channels` under the caller's own RLS; rotate with
 * `api.rotate_channel_secret`.
 *
 * - `supabase` (production): subscribe with supabase-js
 *   `createClient(url, apiKey).channel(topic, { config: { private: false } })
 *   .on('broadcast', { event: '*' }, …)`; each message's payload is a
 *   {@link RealtimeBroadcast} and the broadcast event name is its `type`.
 *   One connection per listening plugin (Free-tier connection caps).
 *   `apiKey` is the project's publishable (anon) key, never a service key.
 * - `local` (server mode without Supabase Realtime): core fans out
 *   in-process, so browsers use `GET /api/v1/stream` (SSE) and agents
 *   `GET /api/v1/pulse`. `topic`/`secret` are still returned so the shape is
 *   the same in both modes.
 */
export const RealtimeChannel = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('supabase'),
    url: z.url({ protocol: /^https?$/ }),
    apiKey: z.string().regex(/^[A-Za-z0-9._-]{20,2048}$/, { error: 'expected a publishable key' }),
    topic: RealtimeTopic,
    secret: ChannelSecret,
  }),
  z.object({
    provider: z.literal('local'),
    topic: RealtimeTopic,
    secret: ChannelSecret,
  }),
]);
export type RealtimeChannel = z.infer<typeof RealtimeChannel>;

/**
 * The payload of one broadcast (`realtime.send(payload, event = type, topic,
 * private = false)` in the events trigger): the `events` row id, its type
 * and its ids-only payload. Subscribers refetch content through the API.
 */
export const RealtimeBroadcast = z.strictObject({
  /** `events.id` (bigserial) as a decimal string; usable as an SSE / pulse cursor. */
  id: z.string().regex(/^\d{1,19}$/),
  type: EventType,
  payload: EventPayload,
});
export type RealtimeBroadcast = z.infer<typeof RealtimeBroadcast>;

/* ========================================================= jobs tick */

/** Path of the serverless job drain on core. */
export const JOBS_TICK_PATH = '/internal/jobs/tick' as const;

/**
 * Who triggered a tick: the pg_cron schedule (`y-jobs-tick`, every
 * minute, via pg_net), core itself after a response (`after`), or an
 * operator (`manual`).
 */
export const JobsTickSource = z.enum(['pg_cron', 'after', 'manual']);
export type JobsTickSource = z.infer<typeof JobsTickSource>;

/**
 * `POST /internal/jobs/tick` body, sent with
 * `Authorization: Bearer <Y_CRON_SECRET>` (the Vault secret
 * `y_jobs_tick_secret`). Core compares the secret in constant time
 * and answers 401 `UNAUTHORIZED` otherwise. `due` is the number of due jobs
 * the database saw when it sent the tick (pg_cron only); core may return
 * immediately when it is 0.
 */
export const JobsTickRequest = z.object({
  source: JobsTickSource,
  due: Count.optional(),
});
export type JobsTickRequest = z.infer<typeof JobsTickRequest>;

/**
 * What one tick did. Core claims jobs with `api.claim_jobs` until
 * {@link JOBS_TICK_BUDGET_MS} is spent or nothing is due. `remaining` is the
 * number of due jobs left, when cheaply known.
 */
export const JobsTickResponse = z.object({
  ok: z.literal(true),
  mode: HostingMode,
  claimed: Count,
  completed: Count,
  failed: Count,
  remaining: Count.nullable(),
  durationMs: Count,
});
export type JobsTickResponse = z.infer<typeof JobsTickResponse>;

/**
 * Wall-clock budget for one tick or one `after()` drain, ms. Stays well
 * inside a Vercel Hobby function's duration limit; pg_net stops waiting for
 * the response after 5 s, which does not cancel the drain.
 */
export const JOBS_TICK_BUDGET_MS = 8_000;

/** Header name for the tick's shared secret (`Authorization: Bearer …`). */
export const JOBS_TICK_AUTH_HEADER = 'authorization' as const;
