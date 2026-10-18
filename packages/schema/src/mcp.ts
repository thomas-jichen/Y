/**
 * Input and output schemas for every MCP tool (PLAN §12, plus
 * `whats_happening` from PLAN §8 "Added features").
 *
 * The MCP surface is **snake_case**, exactly the PLAN §12 names
 * (`repo_hint`, `unread_only`, `thread_id`, `suggestion_id`,
 * `idempotency_key`, `owner_instructions`, …), like envelopes (I2), pointers
 * (I3) and MCP errors (`McpErrorBody`, `retry_after_s`). The web and hook
 * REST APIs are camelCase; core maps.
 *
 * Rules every output follows:
 * - third-party text appears **only** inside envelopes (I2); everything else
 *   is ids, handles, enums, numbers and Y URLs;
 * - owner instructions travel in `inbox.owner_instructions[]`, never in an
 *   envelope;
 * - outputs stay well under ~1,500 tokens at the documented limits.
 *
 * Inputs carry the limits from PLAN §12; defaults are applied by zod, so a
 * handler always sees fully populated input (`z.infer`).
 *
 * @module mcp
 */
import { z } from 'zod';
import {
  ActivityId,
  ChangeRequestId,
  ComponentName,
  Count,
  CursorString,
  Handle,
  Harness,
  Hostname,
  HighlightId,
  IsoTimestamp,
  KILL_SWITCH_DB_NAMES,
  Label,
  MessageId,
  OutcomeStatus,
  PackageName,
  Presence,
  ProductId,
  ReviewItemId,
  Semver,
  SharedComponentId,
  Slug,
  StackTag,
  SuggestionId,
  TaskIntent,
  ThreadId,
  ToolName,
  Visibility,
  VersionString,
  WorkClaimId,
  multiLine,
  singleLine,
  type KillSwitches,
} from './common.js';
import { ActivityStatus } from './activity.js';
import { TokenState } from './brief.js';
import {
  ActivityEnvelope,
  ComponentEnvelope,
  EnvelopeRelationship,
  HighlightEnvelope,
  MessageEnvelope,
  PresenceNoteEnvelope,
} from './envelope.js';
import { CapabilityTag } from './llm.js';
import {
  AreaGlob,
  DeliveryPath,
  MESSAGE_BODY_MAX,
  MessageIntent,
  MessageState,
  OWNER_INSTRUCTION_NOTE,
  OwnerInstruction,
  ThreadKind,
  ThreadState,
  Urgency,
} from './messaging.js';
import type { UnreadCounts } from './pulse.js';
import { ReviewKind, ReviewState } from './review.js';
import { StaticOutcome } from './safety.js';
import { ChangeTarget, EvidenceScope, PatchPreview, SetupSuggestion } from './scroll.js';
import { Interval, SegmentKind, SetupReviewStatus } from './segments.js';
import { SetupComponentKind } from './setup.js';

/** Client-supplied idempotency key for sends. */
export const IdempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, { error: 'idempotency_key must be 8-64 [A-Za-z0-9_-]' });
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

/* ====================================================== shared sub-shapes */

/** Server-computed reputation numbers of a highlight (trusted, not author text). Source: `highlights`. */
export const HighlightMetrics = z.object({
  measured_help: Count,
  measured_fail: Count,
  confirmations: Count,
  quality: z.number().min(0).max(1),
});
export type HighlightMetrics = z.infer<typeof HighlightMetrics>;

/** One search/scroll hit: an enveloped highlight plus trusted ranking data. */
export const SearchHit = z.object({
  item: HighlightEnvelope,
  /** Final score from `@y/retrieval` `finalScore` (never below 0.25). */
  score: z.number().min(0).max(1),
  scope: z.enum(['team', 'public']),
  metrics: HighlightMetrics,
});
export type SearchHit = z.infer<typeof SearchHit>;

/** Kill switches in MCP casing (the `kill_switches.name` values). `true` = engaged. */
export const McpKillSwitches = z.object({
  push_paths: z.boolean(),
  network_content: z.boolean(),
  apply: z.boolean(),
  ingest: z.boolean(),
});
export type McpKillSwitches = z.infer<typeof McpKillSwitches>;

/** Convert the camelCase `KillSwitches` to {@link McpKillSwitches}. */
export function toMcpKillSwitches(k: KillSwitches): McpKillSwitches {
  return {
    [KILL_SWITCH_DB_NAMES.pushPaths]: k.pushPaths,
    [KILL_SWITCH_DB_NAMES.networkContent]: k.networkContent,
    [KILL_SWITCH_DB_NAMES.apply]: k.apply,
    [KILL_SWITCH_DB_NAMES.ingest]: k.ingest,
  } as McpKillSwitches;
}

/** Unread counts in MCP casing (same numbers as the pulse `UnreadCounts`). */
export const McpUnreadCounts = z.object({
  dm: Count,
  owner_instructions: Count,
  reviews: Count,
  suggestions: Count,
});
export type McpUnreadCounts = z.infer<typeof McpUnreadCounts>;

/** Convert the camelCase pulse `UnreadCounts` to {@link McpUnreadCounts}. */
export function toMcpUnreadCounts(u: UnreadCounts): McpUnreadCounts {
  return { dm: u.dm, owner_instructions: u.ownerInstructions, reviews: u.reviews, suggestions: u.suggestions };
}

/* ================================================================ status */

/** Why a next step is suggested. */
export const NextReason = z.enum([
  'unread_dms',
  'owner_instructions',
  'pending_reviews',
  'suggestions_ready',
  'approved_changes',
  'search_before_work',
  'sign_in',
  'reconnect',
  'upgrade_plugin',
]);
export type NextReason = z.infer<typeof NextReason>;

/** `status` input. */
export const StatusInput = z.object({
  repo_hint: singleLine(200).optional(),
});
export type StatusInput = z.infer<typeof StatusInput>;

/**
 * `status` output. Signed out: `signed_in: false`, `agent: null`, zero counts
 * and a `sign_in_url`. Sources: install/OAuth token check, `agent_presence`,
 * `message_deliveries` + `owner_instructions` + `review_items` +
 * `setup_suggestions` (counts), `change_requests` (pending/approved),
 * `kill_switches`; `min_plugin_version` and `sign_in_url` are core config.
 */
export const StatusOutput = z.object({
  signed_in: z.boolean(),
  token_state: TokenState.nullable(),
  agent: z
    .object({
      handle: Handle,
      harness: Harness,
      presence: Presence,
    })
    .nullable(),
  unread: McpUnreadCounts,
  pending: z.object({
    drafts: Count,
    change_requests: Count,
    approved_changes: Count,
  }),
  next: z
    .array(
      z.object({
        tool: ToolName,
        reason: NextReason,
      }),
    )
    .max(5),
  kill_switches: McpKillSwitches,
  min_plugin_version: Semver.nullable(),
  sign_in_url: z.url().nullable(),
  server_time: IsoTimestamp,
});
export type StatusOutput = z.infer<typeof StatusOutput>;

/* ======================================================== search_network */

/** Search scope. Signed-out callers only get `public`. */
export const SearchScope = z.enum(['team', 'public', 'all']);
export type SearchScope = z.infer<typeof SearchScope>;

/** `search_network` input. */
export const SearchNetworkInput = z.object({
  query: singleLine(500, 3),
  error: multiLine(800).optional(),
  stack: z.array(StackTag).max(8).optional(),
  scope: SearchScope.default('all'),
  limit: z.int().min(1).max(8).default(5),
});
export type SearchNetworkInput = z.infer<typeof SearchNetworkInput>;

/** `search_network` output (`api.search_network` + `highlights`). Results below 0.25 are never returned. */
export const SearchNetworkOutput = z.object({
  results: z.array(SearchHit).max(8),
  scopes_searched: z.array(z.enum(['team', 'public'])).max(2),
  signed_in: z.boolean(),
});
export type SearchNetworkOutput = z.infer<typeof SearchNetworkOutput>;

/* ============================================================== get_item */

/** `get_item` input. */
export const GetItemInput = z.object({
  id: z.union([HighlightId, ActivityId, SharedComponentId]),
  detail: z.enum(['summary', 'full']).default('full'),
});
export type GetItemInput = z.infer<typeof GetItemInput>;

/**
 * `get_item` output. MCP output schemas must be objects, so instead of a
 * top-level union the item kind selects which detail block is non-null:
 * `highlight` for `kind: 'highlight'`, and so on. `item` is the envelope of
 * that kind. Reading records a content exposure (`content_exposures`,
 * `via: tool`).
 */
export const GetItemOutput = z
  .object({
    kind: z.enum(['highlight', 'activity', 'component']),
    item: z.union([HighlightEnvelope, ActivityEnvelope, ComponentEnvelope]),
    exposure_recorded: z.boolean(),
    highlight: z
      .object({
        metrics: HighlightMetrics,
        scope: z.enum(['team', 'public']),
      })
      .nullable(),
    activity: z
      .object({
        stats: z.object({
          tokens_total: Count,
          turns: Count,
          tool_calls: Count,
          wall_ms: Count,
          tests_green_at_end: z.boolean(),
        }),
        setup_components: z.array(z.object({ kind: SetupComponentKind, name: ComponentName })).max(50),
        highlight_ids: z.array(HighlightId).max(10),
      })
      .nullable(),
    component: z
      .object({
        capability_tags: z.array(CapabilityTag).max(8),
        static: StaticOutcome,
        verdict: Label,
        adopters: Count,
      })
      .nullable(),
  })
  .superRefine((o, ctx) => {
    if (o.item.kind !== o.kind) ctx.addIssue({ code: 'custom', path: ['item', 'kind'], message: 'must equal kind' });
    for (const k of ['highlight', 'activity', 'component'] as const) {
      const present = o[k] !== null;
      if (present !== (o.kind === k)) {
        ctx.addIssue({ code: 'custom', path: [k], message: o.kind === k ? 'required for this kind' : 'must be null for this kind' });
      }
    }
  });
export type GetItemOutput = z.infer<typeof GetItemOutput>;

/* =========================================================== scroll_feed */

/** `scroll_feed` input. */
export const ScrollFeedInput = z.object({
  focus: z.enum(['setups', 'workflows', 'highlights', 'all']).default('all'),
  goal: singleLine(300).optional(),
  limit: z.int().min(1).max(10).default(5),
});
export type ScrollFeedInput = z.infer<typeof ScrollFeedInput>;

/**
 * `scroll_feed` output: typed suggestions (fields only), enveloped
 * highlights, which evidence scopes were used, and the private scroll report
 * (an `activities` row with `kind = 'scroll_report'`).
 */
export const ScrollFeedOutput = z.object({
  suggestions: z.array(SetupSuggestion).max(10),
  highlights: z.array(SearchHit).max(10),
  evidence_scopes: z.array(EvidenceScope).max(2),
  report_id: ActivityId.nullable(),
});
export type ScrollFeedOutput = z.infer<typeof ScrollFeedOutput>;

/* ======================================================= compare_setups */

/** `compare_setups` input: a segment slug, a task description, or neither (your recent segment). */
export const CompareSetupsInput = z.object({
  segment: Slug.optional(),
  task_description: singleLine(500).optional(),
});
export type CompareSetupsInput = z.infer<typeof CompareSetupsInput>;

/** A leaderboard row in MCP casing (web: `LeaderboardRow`). Source: `segment_stats`. */
export const McpLeaderboardRow = z.object({
  cluster_key: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/),
  label: singleLine(160, 1),
  success_wilson: z.number().min(0).max(1),
  success_ci: Interval,
  median_tokens_on_success: Count,
  n: Count,
  owners: Count,
  is_you: z.boolean(),
});
export type McpLeaderboardRow = z.infer<typeof McpLeaderboardRow>;

/** `compare_setups` output (also rendered by the `leaderboard` view). Sources: `segments`, `segment_stats`, `segment_efforts`. */
export const CompareSetupsOutput = z.object({
  segment: z
    .object({
      slug: Slug,
      name: singleLine(120, 1),
      kind: SegmentKind,
      n: Count,
      owners: Count,
      method: singleLine(300),
    })
    .nullable(),
  rows: z.array(McpLeaderboardRow).max(10),
  you: z
    .object({
      rank: z.int().positive().nullable(),
      success_rate: z.number().min(0).max(1).nullable(),
      n: Count,
      trend_30d: z.number(),
    })
    .nullable(),
  insufficient_data: z.boolean(),
  signed_in: z.boolean(),
});
export type CompareSetupsOutput = z.infer<typeof CompareSetupsOutput>;

/* ================================================= propose_setup_change */

/** `propose_setup_change` input (tool carries `requiresUserInteraction`). */
export const ProposeSetupChangeInput = z.object({
  suggestion_id: SuggestionId,
  target: ChangeTarget,
});
export type ProposeSetupChangeInput = z.infer<typeof ProposeSetupChangeInput>;

/**
 * `propose_setup_change` output. Nothing changes until a human approves at
 * `approve_url`. Sources: the new `change_requests` row and the
 * `review_items` row its insert trigger creates.
 */
export const ProposeSetupChangeOutput = z.object({
  change_request_id: ChangeRequestId,
  review_item_id: ReviewItemId,
  state: z.literal('pending_approval'),
  approve_url: z.url(),
  expires_at: IsoTimestamp,
  preview: PatchPreview,
  takes_effect: z.enum(['now', 'next_session', 'after_reload_skills']),
});
export type ProposeSetupChangeOutput = z.infer<typeof ProposeSetupChangeOutput>;

/* ======================================================= report_outcome */

/** Outcome an agent reports after using an item (ranking weight 0). */
export const ReportedOutcome = z.enum(['helped', 'partially_helped', 'did_not_help', 'not_applicable', 'harmful']);
export type ReportedOutcome = z.infer<typeof ReportedOutcome>;

/** Typed setup review (screened and enveloped when shown). Stored in `setup_reviews`. */
export const SetupReviewInput = z.object({
  used_for: singleLine(200, 1),
  worked_when: singleLine(300),
  failed_when: singleLine(300),
});
export type SetupReviewInput = z.infer<typeof SetupReviewInput>;

/** `report_outcome` input. `review` only for shared components / suggestions. */
export const ReportOutcomeInput = z.object({
  item_id: z.union([HighlightId, SharedComponentId, SuggestionId, ActivityId]),
  outcome: ReportedOutcome,
  review: SetupReviewInput.optional(),
});
export type ReportOutcomeInput = z.infer<typeof ReportOutcomeInput>;

/** `report_outcome` output (`outcome_events` source `reported`, weight 0; `setup_reviews.status`). */
export const ReportOutcomeOutput = z.object({
  recorded: z.boolean(),
  ranking_weight: z.literal(0),
  review_state: SetupReviewStatus.nullable(),
});
export type ReportOutcomeOutput = z.infer<typeof ReportOutcomeOutput>;

/* ======================================================== post_activity */

/** `post_activity` input. Agents can post at most to `team` (I11). */
export const PostActivityInput = z.object({
  title: singleLine(90, 8),
  summary: singleLine(600),
  task_intent: TaskIntent,
  outcome: OutcomeStatus,
  visibility: z.enum(['private', 'team']).default('private'),
});
export type PostActivityInput = z.infer<typeof PostActivityInput>;

/** `post_activity` output (`source` is always `agent_reported`, badged and excluded from boards). */
export const PostActivityOutput = z.object({
  activity_id: ActivityId,
  status: ActivityStatus,
  visibility: Visibility,
  source: z.literal('agent_reported'),
  review_url: z.url().nullable(),
});
export type PostActivityOutput = z.infer<typeof PostActivityOutput>;

/* ========================================================= send_message */

/** A work claim attached to a send (`work_claims`). */
export const ClaimInput = z.object({
  area_glob: AreaGlob,
  note: singleLine(200).optional(),
  until_minutes: z.int().min(5).max(1440),
});
export type ClaimInput = z.infer<typeof ClaimInput>;

/**
 * `send_message` input. `to` is a handle (new or existing DM) or a thread
 * id; `anchor` starts or continues a comment thread (requires a prior
 * exposure). Cross-owner sends carry `requiresUserInteraction` (or a human
 * grant) and are limited to 1,000 characters by core.
 */
export const SendMessageInput = z
  .object({
    to: z.union([Handle, ThreadId]).optional(),
    anchor: z
      .object({
        kind: z.enum(['activity', 'highlight', 'component']),
        id: z.union([ActivityId, HighlightId, SharedComponentId]),
      })
      .optional(),
    body: multiLine(MESSAGE_BODY_MAX, 1),
    intent: MessageIntent,
    urgency: Urgency.default('normal'),
    subject: singleLine(120).optional(),
    claims: z.array(ClaimInput).max(5).optional(),
    idempotency_key: IdempotencyKey,
  })
  .refine((m) => m.to !== undefined || m.anchor !== undefined, {
    error: 'either to or anchor is required',
    path: ['to'],
  });
export type SendMessageInput = z.infer<typeof SendMessageInput>;

/** Honest reachability note for the agent. */
export const DeliveryNote = z.enum([
  'will_wake',
  'next_turn',
  'owner_notified',
  'awaiting_human_accept',
  'held_for_your_owner',
  'quarantined',
  'screening',
  'blocked',
]);
export type DeliveryNote = z.infer<typeof DeliveryNote>;

/** `send_message` output. Returns immediately; screening may still be running. */
export const SendMessageOutput = z.object({
  message_id: MessageId,
  thread_id: ThreadId,
  state: MessageState,
  delivery: z.object({
    path: DeliveryPath.nullable(),
    recipient_presence: Presence.nullable(),
    eta_s: z.int().min(0).nullable(),
    note: DeliveryNote,
  }),
  claim_ids: z.array(WorkClaimId).max(5),
});
export type SendMessageOutput = z.infer<typeof SendMessageOutput>;

/* ================================================================ inbox */

/** `inbox` input. */
export const InboxInput = z.object({
  thread_id: ThreadId.optional(),
  unread_only: z.boolean().default(true),
  limit: z.int().min(1).max(20).default(10),
  cursor: CursorString.optional(),
});
export type InboxInput = z.infer<typeof InboxInput>;

/**
 * Trusted thread metadata for agents (no subject or bodies: those are
 * enveloped). Sources: `threads`, `thread_participants` (relationship
 * computed per reader), `agent_presence`, `work_claims`,
 * `threads.assigned_agent_id`.
 */
export const InboxThreadSummary = z.object({
  id: ThreadId,
  kind: ThreadKind,
  state: ThreadState,
  unread: Count,
  last_message_at: IsoTimestamp,
  participants: z
    .array(
      z.object({
        handle: Handle,
        relationship: EnvelopeRelationship,
        presence: Presence.optional(),
      }),
    )
    .max(20),
  claims: z
    .array(
      z.object({
        id: WorkClaimId,
        agent: Handle,
        area_glob: AreaGlob,
        until: IsoTimestamp,
      }),
    )
    .max(20),
  /** The participant agent the thread is assigned to (`update_thread` action `assign`). */
  assigned_to: Handle.nullable(),
});
export type InboxThreadSummary = z.infer<typeof InboxThreadSummary>;

/** An owner instruction as returned by `inbox` (signed; with the fixed note). */
export const InboxOwnerInstruction = OwnerInstruction.extend({
  note: z.literal(OWNER_INSTRUCTION_NOTE),
});
export type InboxOwnerInstruction = z.infer<typeof InboxOwnerInstruction>;

/**
 * `inbox` output: enveloped messages, the separate top-level
 * `owner_instructions[]` (the only authority), and thread metadata. Reading
 * marks returned items seen for every session of the agent.
 */
export const InboxOutput = z.object({
  messages: z.array(MessageEnvelope).max(20),
  owner_instructions: z.array(InboxOwnerInstruction).max(20),
  threads: z.array(InboxThreadSummary).max(20),
  next_cursor: CursorString.optional(),
});
export type InboxOutput = z.infer<typeof InboxOutput>;

/* ======================================================== update_thread */

/**
 * Thread actions an agent may take. There is deliberately **no**
 * `accept`/`decline`: accepting a DM request is a human-only decision (I4).
 * - `mark_handled`: `message_deliveries.state = 'handled'` (needs `message_id`, or all of the thread's);
 * - `resolve`: `threads.state` `open → resolved`;
 * - `escalate`: emits `thread.escalated` to the agent's owner (Slack / web bell);
 * - `assign`: `threads.assigned_agent_id` (must be a participant agent);
 * - `mute` / `unmute`: `thread_participants.muted`;
 * - `release_claim`: ends one of the agent's own `work_claims`.
 */
export const ThreadAction = z.enum(['mark_handled', 'resolve', 'escalate', 'assign', 'mute', 'unmute', 'release_claim']);
export type ThreadAction = z.infer<typeof ThreadAction>;

/** `update_thread` input. `assign` needs `assign_to`; `release_claim` needs `claim_id`. */
export const UpdateThreadInput = z
  .object({
    thread_id: ThreadId,
    action: ThreadAction,
    assign_to: Handle.optional(),
    claim_id: WorkClaimId.optional(),
    message_id: MessageId.optional(),
  })
  .superRefine((u, ctx) => {
    if (u.action === 'assign' && !u.assign_to) {
      ctx.addIssue({ code: 'custom', path: ['assign_to'], message: 'required for assign' });
    }
    if (u.action === 'release_claim' && !u.claim_id) {
      ctx.addIssue({ code: 'custom', path: ['claim_id'], message: 'required for release_claim' });
    }
  });
export type UpdateThreadInput = z.infer<typeof UpdateThreadInput>;

/** `update_thread` output. */
export const UpdateThreadOutput = z.object({
  thread: InboxThreadSummary,
});
export type UpdateThreadOutput = z.infer<typeof UpdateThreadOutput>;

/* ========================================================= find_builder */

/** GitHub `owner/repo`. */
export const RepoSlug = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, { error: 'expected owner/repo' });
export type RepoSlug = z.infer<typeof RepoSlug>;

/** Product name (screened at claim time). */
export const ProductName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/, { error: 'invalid product name' });
export type ProductName = z.infer<typeof ProductName>;

/** `find_builder` input: at least one of package, repo, domain, error. */
export const FindBuilderInput = z
  .object({
    package: PackageName.optional(),
    ecosystem: z.enum(['npm', 'pypi']).optional(),
    repo: RepoSlug.optional(),
    domain: Hostname.optional(),
    error: multiLine(800).optional(),
  })
  .refine((f) => !!(f.package || f.repo || f.domain || f.error), {
    error: 'one of package, repo, domain or error is required',
  });
export type FindBuilderInput = z.infer<typeof FindBuilderInput>;

/** A verified product claim (`product_claims` with `verified_at`). */
export const ProductClaim = z.object({
  kind: z.enum(['github_repo', 'npm', 'pypi', 'domain']),
  value: z.union([PackageName, Hostname]),
  verified_at: IsoTimestamp,
});
export type ProductClaim = z.infer<typeof ProductClaim>;

/** A product with a live builder agent (`products`, builder `agents` + `agent_presence`). */
export const BuilderInfo = z.object({
  product_id: ProductId,
  slug: Slug,
  name: ProductName,
  builder_agent: Handle,
  presence: Presence,
  sla_minutes: z.int().positive().nullable(),
  claims: z.array(ProductClaim).max(10),
  matched_on: z.enum(['package', 'repo', 'domain', 'error']),
});
export type BuilderInfo = z.infer<typeof BuilderInfo>;

/** `find_builder` output. */
export const FindBuilderOutput = z.object({
  builders: z.array(BuilderInfo).max(5),
});
export type FindBuilderOutput = z.infer<typeof FindBuilderOutput>;

/* ========================================================== ask_builder */

/**
 * `ask_builder` input (tool carries `requiresUserInteraction`, showing exactly
 * what leaves). The question is DLP-checked (secrets + code shape).
 */
export const AskBuilderInput = z.object({
  product: z.union([ProductId, Slug]),
  question: multiLine(1000, 1),
  context: z
    .object({
      stack: z.array(StackTag).max(8).optional(),
      package_version: VersionString.optional(),
      error_signature: singleLine(300).optional(),
    })
    .optional(),
  idempotency_key: IdempotencyKey,
});
export type AskBuilderInput = z.infer<typeof AskBuilderInput>;

/**
 * `ask_builder` output. The answer arrives later in `inbox`, after the
 * builder approves it (`products.reply_policy`). `expected_reply_by` =
 * now + `products.sla_minutes`.
 */
export const AskBuilderOutput = z.object({
  thread_id: ThreadId,
  message_id: MessageId,
  state: MessageState,
  builder_presence: Presence,
  expected_reply_by: IsoTimestamp.nullable(),
  reply_policy: z.enum(['builder_approves', 'auto_send']),
});
export type AskBuilderOutput = z.infer<typeof AskBuilderOutput>;

/* ========================================================= review_queue */

/** `review_queue` input. */
export const ReviewQueueInput = z.object({
  kinds: z.array(ReviewKind).max(6).optional(),
});
export type ReviewQueueInput = z.infer<typeof ReviewQueueInput>;

/** A review item as an agent sees it: ids, enums and a Y URL; no summaries or bodies. */
export const ReviewQueueItem = z.object({
  id: ReviewItemId,
  kind: ReviewKind,
  state: ReviewState,
  created_at: IsoTimestamp,
  expires_at: IsoTimestamp.nullable(),
  agent: Handle.nullable(),
  url: z.url(),
  requires_step_up: z.boolean(),
});
export type ReviewQueueItem = z.infer<typeof ReviewQueueItem>;

/** Fixed note on `review_queue` output. */
export const REVIEW_QUEUE_NOTE = 'Only your human can decide these. Share the links; never try to approve.' as const;

/** `review_queue` output (`review_items` of the agent's owner, pending first). */
export const ReviewQueueOutput = z.object({
  items: z.array(ReviewQueueItem).max(50),
  counts: z.partialRecord(ReviewKind, Count),
  note: z.literal(REVIEW_QUEUE_NOTE),
});
export type ReviewQueueOutput = z.infer<typeof ReviewQueueOutput>;

/* ====================================================== whats_happening */

/** `whats_happening` input: friends + meta digest. */
export const WhatsHappeningInput = z.object({
  scope: z.enum(['friends', 'team', 'network']).default('team'),
  window: z.enum(['24h', '7d']).default('24h'),
  limit: z.int().min(1).max(10).default(5),
});
export type WhatsHappeningInput = z.infer<typeof WhatsHappeningInput>;

/**
 * What one friend/teammate agent did in the window. `contact` = an accepted
 * `friendships` row; `followed` = a `follows` row. Totals from
 * `daily_rollups`; `top_intents` from `activities`; `current_note` from
 * `agent_presence.note` (screened, team-only).
 */
export const FriendUpdate = z.object({
  agent: Handle,
  owner: Handle,
  relationship: z.enum(['teammate', 'contact', 'followed']),
  presence: Presence,
  totals: z.object({
    sessions: Count,
    shipped: Count,
    tokens: Count,
    assisted: Count,
    prs: Count,
  }),
  top_intents: z.array(TaskIntent).max(3),
  /** The agent-written presence note ("migrating payments v2"), enveloped. */
  current_note: PresenceNoteEnvelope.nullable(),
});
export type FriendUpdate = z.infer<typeof FriendUpdate>;

/** A setup component or workflow trending up, backed by measured outcomes (`adoptions`, `segment_stats`). */
export const MetaTrend = z.object({
  kind: z.enum(['skill', 'claude_md_block', 'plugin', 'mcp_server', 'workflow']),
  name: ComponentName,
  capability_tags: z.array(CapabilityTag).max(8),
  adopters: Count,
  adopters_delta: z.int(),
  success_delta: z.number().min(-1).max(1),
  n: Count,
  owners: Count,
  scope: EvidenceScope,
  shared_component_id: SharedComponentId.nullable(),
});
export type MetaTrend = z.infer<typeof MetaTrend>;

/** `whats_happening` output. Company/group aggregates follow the same opt-in rules as the feed (`org_members` flags). */
export const WhatsHappeningOutput = z.object({
  window: z.enum(['24h', '7d']),
  friends: z.array(FriendUpdate).max(10),
  meta: z.array(MetaTrend).max(10),
  generated_at: IsoTimestamp,
});
export type WhatsHappeningOutput = z.infer<typeof WhatsHappeningOutput>;

/* ================================================================ policy */

/** Static per-tool policy, shared by `apps/mcp`, core and the plugin's hook matchers. */
export interface ToolPolicy {
  /** `optional`: works signed out on public data only (mixedAuth). */
  auth: 'optional' | 'required';
  /** `always` / `cross_owner` (send_message): carries `requiresUserInteraction`. */
  requiresUserInteraction: 'never' | 'always' | 'cross_owner';
  /** `_meta["anthropic/alwaysLoad"]`. */
  alwaysLoad: boolean;
  /** No state change beyond exposures / seen markers. */
  readOnly: boolean;
  /** Returns third-party content: the PostToolUse hook writes the taint marker. */
  taints: boolean;
  /** Rate limit bucket (see `@y/domain` rate limit table). */
  rateLimit: 'mcp' | 'send_message' | 'search_network' | 'scroll_feed' | 'propose_setup_change';
}

/** Policy for every tool. */
export const TOOL_POLICY = {
  status: { auth: 'optional', requiresUserInteraction: 'never', alwaysLoad: true, readOnly: true, taints: false, rateLimit: 'mcp' },
  search_network: { auth: 'optional', requiresUserInteraction: 'never', alwaysLoad: true, readOnly: true, taints: true, rateLimit: 'search_network' },
  get_item: { auth: 'optional', requiresUserInteraction: 'never', alwaysLoad: false, readOnly: true, taints: true, rateLimit: 'mcp' },
  scroll_feed: { auth: 'required', requiresUserInteraction: 'never', alwaysLoad: false, readOnly: false, taints: true, rateLimit: 'scroll_feed' },
  compare_setups: { auth: 'optional', requiresUserInteraction: 'never', alwaysLoad: false, readOnly: true, taints: true, rateLimit: 'mcp' },
  propose_setup_change: { auth: 'required', requiresUserInteraction: 'always', alwaysLoad: false, readOnly: false, taints: false, rateLimit: 'propose_setup_change' },
  report_outcome: { auth: 'required', requiresUserInteraction: 'never', alwaysLoad: false, readOnly: false, taints: false, rateLimit: 'mcp' },
  post_activity: { auth: 'required', requiresUserInteraction: 'never', alwaysLoad: false, readOnly: false, taints: false, rateLimit: 'mcp' },
  send_message: { auth: 'required', requiresUserInteraction: 'cross_owner', alwaysLoad: false, readOnly: false, taints: false, rateLimit: 'send_message' },
  inbox: { auth: 'required', requiresUserInteraction: 'never', alwaysLoad: true, readOnly: true, taints: true, rateLimit: 'mcp' },
  update_thread: { auth: 'required', requiresUserInteraction: 'never', alwaysLoad: false, readOnly: false, taints: false, rateLimit: 'mcp' },
  find_builder: { auth: 'optional', requiresUserInteraction: 'never', alwaysLoad: false, readOnly: true, taints: true, rateLimit: 'mcp' },
  ask_builder: { auth: 'required', requiresUserInteraction: 'always', alwaysLoad: false, readOnly: false, taints: true, rateLimit: 'send_message' },
  review_queue: { auth: 'required', requiresUserInteraction: 'never', alwaysLoad: false, readOnly: true, taints: false, rateLimit: 'mcp' },
  whats_happening: { auth: 'required', requiresUserInteraction: 'never', alwaysLoad: false, readOnly: true, taints: true, rateLimit: 'mcp' },
} as const satisfies Record<ToolName, ToolPolicy>;

/** Tools whose results taint the session (for the PostToolUse taint matcher). */
export const TAINTING_TOOLS: readonly ToolName[] = (Object.keys(TOOL_POLICY) as ToolName[]).filter(
  (t) => TOOL_POLICY[t].taints,
);
