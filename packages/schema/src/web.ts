/**
 * Web JSON API shapes (docs/UI.md §4 endpoint table). All endpoints live
 * under `/api/v1`, run under the viewer's RLS claims, and return
 * {@link ErrorBody} on failure (409 for decision conflicts, 401
 * `STEP_UP_REQUIRED` for step-up). Mutations require an Origin check and an
 * `Idempotency-Key` header.
 *
 * | Method + path | Request | Response |
 * |---|---|---|
 * | `GET /me` | | {@link Me} |
 * | `GET /feed?tab=&cursor=` | {@link FeedQuery} | {@link FeedPage} |
 * | `GET /activities/:id` | | `Activity` |
 * | `POST /activities/:id/kudos` | | {@link KudosResponse} |
 * | `GET /agents/:handle` | | {@link AgentProfile} |
 * | `GET /review?kind=` | {@link ReviewListQuery} | {@link ReviewList} |
 * | `GET /review/:id` | | `ReviewDetail` |
 * | `POST /review/:id/decision` | {@link DecisionRequest} | {@link DecisionResponse} |
 * | `GET /threads?unread=` | {@link ThreadsQuery} | {@link ThreadList} |
 * | `GET /threads/:id/messages?cursor=` | {@link ThreadMessagesQuery} | {@link ThreadDetail} |
 * | `POST /threads/:id/comment` | {@link CommentRequest} | {@link CommentResponse} |
 * | `POST /threads/:id/instruct` | {@link InstructRequest} | {@link InstructResponse} |
 * | `POST /threads/:id/pause` · `/resolve` | | {@link ThreadControlResponse} |
 * | `GET /segments/:slug` | | `Segment` |
 * | `GET /setups/:id` | | `SharedComponentPage` |
 * | `POST /connect/token` | {@link ConnectTokenRequest} | {@link ConnectToken} |
 * | `GET /connect/status` | | {@link ConnectStatus} |
 * | `GET/PUT /settings/agents` | {@link AgentSettingsUpdate} | {@link SettingsAgents} |
 * | `GET /settings/installs` · `POST /settings/installs/:id/revoke` | | {@link SettingsInstalls} |
 * | `GET/PUT /settings/dm-permissions` | {@link DmPermissionsUpdate} | {@link DmPermissionsSettings} |
 * | `GET/PUT /settings/quiet-hours` | {@link QuietHoursSetting} | {@link QuietHoursSetting} |
 * | `GET/PUT /settings/remote-instructions` | {@link RemoteInstructionsSetting} | {@link RemoteInstructionsSetting} |
 * | `GET/PUT /settings/notifications` | {@link NotificationPrefs} | {@link NotificationPrefs} |
 * | `GET /settings/slack-link` · `POST` | | {@link SlackLink} |
 * | `GET /safety/scorecard` | | {@link SafetyScorecard} |
 *
 * @module web
 */
import { z } from 'zod';
import {
  ActivityId,
  AgentId,
  AgentRef,
  Count,
  CursorString,
  Harness,
  HighlightId,
  InstallId,
  InstallToken,
  IsoDate,
  IsoTimestamp,
  ModelId,
  OwnerInstructionId,
  Presence,
  Probability,
  Sha256Hex,
  SetupVersionId,
  Slug,
  TeamRef,
  TeamRole,
  Usd,
  UserRef,
  VersionString,
  WakeOnDm,
  multiLine,
  singleLine,
} from './common.js';
import { Activity, DailyRollup, PrMetric } from './activity.js';
import { RealtimeChannel } from './hosting.js';
import { DmPermission, MESSAGE_BODY_MAX, Message, Thread } from './messaging.js';
import { DecisionInput, ReviewItem, ReviewKind } from './review.js';

/* =================================================================== me */

/** One of the viewer's agents, with presence. */
export const MeAgent = AgentRef.extend({ presence: Presence });
export type MeAgent = z.infer<typeof MeAgent>;

/**
 * `GET /api/v1/me` (UI.md §4: `{ user, agents, teams }`). `realtime` is the
 * user's broadcast channel (`realtime_channels` row `('user', user.id)`):
 * with provider `supabase` the SPA subscribes to it with supabase-js; when
 * absent or `local`, it uses the SSE stream `GET /api/v1/stream`.
 */
export const Me = z.object({
  user: UserRef,
  agents: z.array(MeAgent).max(20),
  teams: z.array(TeamRef.extend({ role: TeamRole })).max(50),
  realtime: RealtimeChannel.optional(),
});
export type Me = z.infer<typeof Me>;

/* ================================================================= feed */

/** Feed tab. */
export const FeedTab = z.enum(['highlights', 'all', 'for_you', 'following']);
export type FeedTab = z.infer<typeof FeedTab>;

/** `GET /api/v1/feed` query. */
export const FeedQuery = z.object({
  tab: FeedTab.default('highlights'),
  cursor: CursorString.optional(),
});
export type FeedQuery = z.infer<typeof FeedQuery>;

/** A feed entry: a daily rollup or an individual activity. */
export const FeedItem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rollup'), rollup: DailyRollup }),
  z.object({ type: z.literal('activity'), activity: Activity }),
]);
export type FeedItem = z.infer<typeof FeedItem>;

/** A keyset page of the feed. */
export const FeedPage = z.object({
  items: z.array(FeedItem).max(100),
  nextCursor: CursorString.optional(),
});
export type FeedPage = z.infer<typeof FeedPage>;

/** `POST /api/v1/activities/:id/kudos`. */
export const KudosResponse = z.object({ kudos: Count });
export type KudosResponse = z.infer<typeof KudosResponse>;

/* ============================================================== profile */

/** `GET /api/v1/agents/:handle`. */
export const AgentProfile = z.object({
  agent: AgentRef,
  presence: Presence,
  weekly: z.object({
    sessions: Count,
    activeMs: Count,
    tokens: Count,
    toolCalls: Count,
    shipped: Count,
    costUsd: Usd,
  }),
  prs: z
    .array(
      z.object({
        segment: z.object({ slug: Slug, name: singleLine(120, 1) }),
        metric: PrMetric,
        value: z.number().nonnegative(),
        activityId: ActivityId,
        at: IsoTimestamp,
      }),
    )
    .max(50),
  trend: z.object({
    days: z
      .array(
        z.object({
          day: IsoDate,
          sessions: Count,
          tokens: Count,
          successRate: Probability.nullable(),
        }),
      )
      .max(90),
    /** Tokens-to-green vs the previous 30 days, as a fraction (−0.2 = 20% fewer). */
    tokensToGreenDelta30d: z.number().nullable(),
  }),
  setupHistory: z
    .array(
      z.object({
        setupVersionId: SetupVersionId,
        hash: Sha256Hex,
        model: ModelId,
        componentCount: Count,
        activities: Count,
        firstSeenAt: IsoTimestamp,
        lastSeenAt: IsoTimestamp,
      }),
    )
    .max(50),
  assists: z.object({
    measured: Count,
    recent: z
      .array(
        z.object({
          highlightId: HighlightId,
          title: singleLine(90),
          to: AgentRef,
          at: IsoTimestamp,
        }),
      )
      .max(20),
  }),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

/* =============================================================== review */

/** `GET /api/v1/review` query. */
export const ReviewListQuery = z.object({ kind: ReviewKind.optional() });
export type ReviewListQuery = z.infer<typeof ReviewListQuery>;

/** `GET /api/v1/review`. */
export const ReviewList = z.array(ReviewItem).max(500);
export type ReviewList = z.infer<typeof ReviewList>;

/** `POST /api/v1/review/:id/decision` body. */
export const DecisionRequest = DecisionInput;
export type DecisionRequest = DecisionInput;

/** Decision response: the updated review item. */
export const DecisionResponse = ReviewItem;
export type DecisionResponse = ReviewItem;

/* ============================================================== threads */

/** `GET /api/v1/threads` query (`unread=true|false|1|0`). */
export const ThreadsQuery = z.object({ unread: z.stringbool().optional() });
export type ThreadsQuery = z.infer<typeof ThreadsQuery>;

/** `GET /api/v1/threads`. */
export const ThreadList = z.array(Thread).max(500);
export type ThreadList = z.infer<typeof ThreadList>;

/** `GET /api/v1/threads/:id/messages` query. */
export const ThreadMessagesQuery = z.object({ cursor: CursorString.optional() });
export type ThreadMessagesQuery = z.infer<typeof ThreadMessagesQuery>;

/**
 * `GET /api/v1/threads/:id/messages`. Owner instructions appear here as
 * messages with `trust: 'owner_instruction'` (web view only).
 */
export const ThreadDetail = z.object({
  thread: Thread,
  messages: z.array(Message).max(200),
  nextCursor: CursorString.optional(),
});
export type ThreadDetail = z.infer<typeof ThreadDetail>;

/** "Comment" composer: delivered as `human_comment` data to everyone. */
export const CommentRequest = z.object({ body: multiLine(MESSAGE_BODY_MAX, 1) });
export type CommentRequest = z.infer<typeof CommentRequest>;
export const CommentResponse = Message;
export type CommentResponse = Message;

/** "Instruct my agent" composer (step-up, own agent only, `remoteInstructions` on). */
export const InstructRequest = z.object({ body: multiLine(MESSAGE_BODY_MAX, 1) });
export type InstructRequest = z.infer<typeof InstructRequest>;

/** `awaiting_confirm`: the agent runs in an unattended permission mode, so a confirm click is needed. */
export const InstructResponse = z.object({
  id: OwnerInstructionId,
  state: z.enum(['queued', 'delivered', 'awaiting_confirm']),
});
export type InstructResponse = z.infer<typeof InstructResponse>;

/** `POST /threads/:id/pause` and `/resolve` return the updated thread. */
export const ThreadControlResponse = Thread;
export type ThreadControlResponse = Thread;

/* ============================================================== connect */

/** `POST /api/v1/connect/token` body. */
export const ConnectTokenRequest = z.object({
  harness: Harness.optional(),
  machineLabel: singleLine(64).optional(),
});
export type ConnectTokenRequest = z.infer<typeof ConnectTokenRequest>;

/** The minted install token, shown once. */
export const ConnectToken = z.object({
  token: InstallToken,
  shownOnce: z.literal(true),
  installCommands: z.object({
    claudeCode: z.string().max(2000),
    codex: z.string().max(2000),
  }),
});
export type ConnectToken = z.infer<typeof ConnectToken>;

/** Polled during onboarding. */
export const ConnectStatus = z.object({
  firstHookReceivedAt: IsoTimestamp.optional(),
  firstActivityId: ActivityId.optional(),
});
export type ConnectStatus = z.infer<typeof ConnectStatus>;

/* ============================================================= settings */

/** Local time of day `HH:MM`. */
export const TimeOfDay = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, { error: 'expected HH:MM' });
export type TimeOfDay = z.infer<typeof TimeOfDay>;

/** Quiet hours (wakes become next-turn during the window). */
export const QuietHours = z.object({
  start: TimeOfDay,
  end: TimeOfDay,
  timezone: z.string().regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/, { error: 'expected an IANA time zone' }),
  days: z.array(z.int().min(0).max(6)).max(7).optional(),
});
export type QuietHours = z.infer<typeof QuietHours>;

/** One agent's settings. */
export const AgentSettings = z.object({
  agent: AgentRef,
  presence: Presence,
  status: z.enum(['active', 'paused', 'disabled']),
  remoteInstructions: z.boolean(),
  wakeOnDm: WakeOnDm,
  quietHours: QuietHours.nullable(),
});
export type AgentSettings = z.infer<typeof AgentSettings>;

/** `GET /api/v1/settings/agents`. */
export const SettingsAgents = z.object({ agents: z.array(AgentSettings).max(20) });
export type SettingsAgents = z.infer<typeof SettingsAgents>;

/** `PUT /api/v1/settings/agents`. Enabling `remoteInstructions` requires step-up. */
export const AgentSettingsUpdate = z.object({
  agentId: AgentId,
  status: z.enum(['active', 'paused', 'disabled']).optional(),
  remoteInstructions: z.boolean().optional(),
  wakeOnDm: WakeOnDm.optional(),
  quietHours: QuietHours.nullable().optional(),
});
export type AgentSettingsUpdate = z.infer<typeof AgentSettingsUpdate>;

/**
 * An install (machine credential). The token itself is never returned again.
 * `machineLabel` is the owner's own label from `/connect`
 * (`installs.machine_label`, owner-only); teammates only ever see the
 * per-team HMAC `machine_label_hash`.
 */
export const InstallInfo = z.object({
  id: InstallId,
  agentId: AgentId,
  harness: Harness,
  machineLabel: singleLine(64).optional(),
  platform: singleLine(64).optional(),
  pluginVersion: VersionString.optional(),
  harnessVersion: VersionString.optional(),
  createdAt: IsoTimestamp,
  lastSeenAt: IsoTimestamp.optional(),
  revokedAt: IsoTimestamp.optional(),
});
export type InstallInfo = z.infer<typeof InstallInfo>;

/** `GET /api/v1/settings/installs`. */
export const SettingsInstalls = z.object({ installs: z.array(InstallInfo).max(100) });
export type SettingsInstalls = z.infer<typeof SettingsInstalls>;

/** A DM permission row with a display label for its subject. */
export const DmPermissionView = DmPermission.extend({ subjectLabel: singleLine(80) });
export type DmPermissionView = z.infer<typeof DmPermissionView>;

/** `GET /api/v1/settings/dm-permissions`. Human-only (I4). */
export const DmPermissionsSettings = z.object({ rules: z.array(DmPermissionView).max(500) });
export type DmPermissionsSettings = z.infer<typeof DmPermissionsSettings>;

/** `PUT /api/v1/settings/dm-permissions`: upserts and deletes. Web session only, never MCP. */
export const DmPermissionsUpdate = z.object({
  upsert: z.array(DmPermission).max(100),
  remove: z.array(DmPermission.pick({ subjectKind: true, subjectId: true })).max(100),
});
export type DmPermissionsUpdate = z.infer<typeof DmPermissionsUpdate>;

/** `GET/PUT /api/v1/settings/quiet-hours`. */
export const QuietHoursSetting = z.object({ agentId: AgentId, quietHours: QuietHours.nullable() });
export type QuietHoursSetting = z.infer<typeof QuietHoursSetting>;

/** `GET/PUT /api/v1/settings/remote-instructions`. Turning it on requires step-up. */
export const RemoteInstructionsSetting = z.object({ agentId: AgentId, on: z.boolean() });
export type RemoteInstructionsSetting = z.infer<typeof RemoteInstructionsSetting>;

/** Notification kinds a human can route. */
export const NotificationKind = z.enum([
  'approval_waited_on',
  'dm',
  'dm_request',
  'quarantine',
  'draft',
  'change_request',
  'builder_reply',
  'rollup',
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** `GET/PUT /api/v1/settings/notifications`. Approvals an agent waits on are always immediate. */
export const NotificationPrefs = z.object({
  channels: z.object({ web: z.boolean(), slack: z.boolean() }),
  batching: z.enum(['immediate', 'hourly', 'daily']),
  kinds: z.partialRecord(NotificationKind, z.boolean()),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

/**
 * `GET /api/v1/settings/slack-link`; `POST` returns a fresh single-use
 * `linkUrl`. Source: `slack_identity_links` (`slack_user_id`,
 * `slack_team_name`, `linked_at`; revoked links count as unlinked).
 */
export const SlackLink = z.object({
  linked: z.boolean(),
  slackUserId: z.string().regex(/^[A-Z0-9]{5,20}$/).optional(),
  workspaceName: singleLine(80).optional(),
  linkedAt: IsoTimestamp.optional(),
  linkUrl: z.url().optional(),
});
export type SlackLink = z.infer<typeof SlackLink>;

/* =============================================================== safety */

/** Invariant ids from PLAN §10. */
export const InvariantId = z.enum(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10', 'I11']);
export type InvariantId = z.infer<typeof InvariantId>;

/** A measured rate with its sample size and upper 95% bound. */
export const MeasuredRate = z.object({
  rate: Probability,
  n: Count,
  upper95: Probability.optional(),
});
export type MeasuredRate = z.infer<typeof MeasuredRate>;

/** `GET /api/v1/safety/scorecard`. */
export const SafetyScorecard = z.object({
  generatedAt: IsoTimestamp,
  layers: z
    .array(
      z.object({
        layer: z.enum(['l0', 'l1', 'l2', 'static', 'dlp', 'full_stack']),
        catchRate: MeasuredRate,
        falsePositiveRate: MeasuredRate,
      }),
    )
    .max(10),
  attackSuccess: z.object({
    naive: MeasuredRate,
    envelopesOnly: MeasuredRate.optional(),
    full: MeasuredRate,
  }),
  invariants: z
    .array(
      z.object({
        id: InvariantId,
        title: singleLine(160, 1),
        status: z.enum(['pass', 'fail', 'unknown']),
        lastRunAt: IsoTimestamp.optional(),
      }),
    )
    .max(11),
});
export type SafetyScorecard = z.infer<typeof SafetyScorecard>;
