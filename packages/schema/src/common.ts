/**
 * Shared primitives for every Y contract: enums, ids, handles, text
 * guards, timestamps and identity references.
 *
 * Wire format is camelCase JSON everywhere. The database is snake_case and
 * `apps/core` maps between the two. Every exported zod schema has an inferred
 * TypeScript type of the same name.
 *
 * @module common
 */
import { z } from 'zod';

/* ================================================================== text */

const CONTROL_SINGLE_LINE = /[\u0000-\u001F\u007F]/;
const CONTROL_MULTI_LINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Source of a character class matching invisible and bidirectional-control
 * characters (soft hyphen, zero-width chars, LRM/RLM, bidi embeddings and
 * isolates, word joiners, BOM). UI.md §5 rule 2 strips these before display;
 * `@y/safety` strips them during normalization.
 */
export const INVISIBLE_CHARS_SOURCE =
  '[\\u00AD\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]';

/** Non-global test regex for {@link INVISIBLE_CHARS_SOURCE}. */
export const INVISIBLE_CHARS_RE = new RegExp(INVISIBLE_CHARS_SOURCE);

/**
 * Remove invisible and bidi-control characters.
 * @returns the cleaned text and how many characters were removed (the UI shows
 *   a "hidden characters removed" chip when `removed > 0`).
 */
export function stripInvisible(text: string): { text: string; removed: number } {
  let removed = 0;
  const cleaned = text.replace(new RegExp(INVISIBLE_CHARS_SOURCE, 'g'), () => {
    removed += 1;
    return '';
  });
  return { text: cleaned, removed };
}

/**
 * A single-line string (no C0 control characters, no newlines) of at most
 * `max` UTF-16 code units.
 */
export function singleLine(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((s) => !CONTROL_SINGLE_LINE.test(s), {
      error: 'must be a single line without control characters',
    });
}

/**
 * A multi-line string (tab, LF and CR allowed; other control characters
 * rejected) of at most `max` UTF-16 code units.
 */
export function multiLine(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((s) => !CONTROL_MULTI_LINE.test(s), {
      error: 'must not contain control characters other than tab and newline',
    });
}

/* ============================================================ time/misc */

/** ISO 8601 timestamp with seconds; `Z` or a numeric offset. Emit `Z`. */
export const IsoTimestamp = z.iso.datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;

/** ISO 8601 calendar date (`YYYY-MM-DD`), used for rollup days. */
export const IsoDate = z.iso.date();
export type IsoDate = z.infer<typeof IsoDate>;

/** Opaque keyset pagination / long-poll cursor. Never an offset. */
export const CursorString = z
  .string()
  .regex(/^[A-Za-z0-9_\-.~=]{1,512}$/, { error: 'invalid cursor' });
export type CursorString = z.infer<typeof CursorString>;

/** Lowercase hex SHA-256 digest. */
export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, { error: 'expected lowercase hex sha256' });
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** Unpadded base64url string (signatures, opaque tokens). */
export const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, { error: 'expected base64url' });
export type Base64Url = z.infer<typeof Base64Url>;

/** Semantic version (`1.2.3`, optional pre-release/build). Used for plugin versions. */
export const Semver = z
  .string()
  .regex(/^\d{1,5}\.\d{1,5}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/, {
    error: 'expected a semver version',
  });
export type Semver = z.infer<typeof Semver>;

/** Loose version string for harness and component versions (`2.1.292`, `0.50.0-alpha`, `1.0.0+abc`). */
export const VersionString = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/, {
  error: 'invalid version string',
});
export type VersionString = z.infer<typeof VersionString>;

/** Model identifier as reported by the harness (`claude-opus-5-5`, `gpt-5-codex`, `claude-opus-5-5[1m]`). */
export const ModelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/, {
  error: 'invalid model id',
});
export type ModelId = z.infer<typeof ModelId>;

/** Fraction in [0, 1] (rates, confidences, Wilson bounds). */
export const Probability = z.number().min(0).max(1);
export type Probability = z.infer<typeof Probability>;

/** Non-negative integer counter. */
export const Count = z.int().nonnegative();
export type Count = z.infer<typeof Count>;

/** Non-negative USD amount. */
export const Usd = z.number().nonnegative();
export type Usd = z.infer<typeof Usd>;

/** A public DNS hostname with at least one dot (never `localhost` or a bare IP literal by convention). */
export const Hostname = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/, {
    error: 'expected a lowercase public hostname',
  });
export type Hostname = z.infer<typeof Hostname>;

/* ================================================================== ids */

/** Crockford base32 ULID, canonical uppercase. */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A bare ULID (DB primary keys of high-volume tables). */
export const Ulid = z.string().regex(ULID_RE, { error: 'expected a ULID' });
export type Ulid = z.infer<typeof Ulid>;

/**
 * Display/wire prefixes for ULID-keyed entities. Wire ids are
 * `<prefix>_<ULID>`; the DB stores the bare ULID and core adds the prefix.
 *
 * PLAN §4 fixes `a_ h_ t_ m_ sg_ cr_`; `p_` (products) and the remaining
 * prefixes are defined here so every component agrees. Posts use `ps_`
 * because `p_` is taken. The DB domain `y_private.prefixed_id` lists the
 * same prefixes (0002, widened in 0009).
 */
export const ID_PREFIXES = {
  activity: 'a',
  highlight: 'h',
  thread: 't',
  message: 'm',
  suggestion: 'sg',
  changeRequest: 'cr',
  product: 'p',
  reviewItem: 'rv',
  ownerInstruction: 'oi',
  workClaim: 'wc',
  sharedComponent: 'cmp',
  setupVersion: 'sv',
  verdict: 'vd',
  post: 'ps',
  postComment: 'pc',
  scroll: 'sc',
  scrollStep: 'ss',
  learning: 'ln',
} as const;
export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const ULID_BODY = '[0-9A-HJKMNP-TV-Z]{26}';

/** Regex for a prefixed id of the given kind (`^a_<ULID>$`). */
export function prefixedIdRegex(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_${ULID_BODY}$`);
}

function prefixedId(kind: IdKind) {
  return z.string().regex(prefixedIdRegex(kind), {
    error: `expected a ${ID_PREFIXES[kind]}_<ULID> id`,
  });
}

/** `a_<ULID>`: activity. */
export const ActivityId = prefixedId('activity');
export type ActivityId = z.infer<typeof ActivityId>;
/** `h_<ULID>`: highlight. */
export const HighlightId = prefixedId('highlight');
export type HighlightId = z.infer<typeof HighlightId>;
/** `t_<ULID>`: thread. */
export const ThreadId = prefixedId('thread');
export type ThreadId = z.infer<typeof ThreadId>;
/** `m_<ULID>`: message. */
export const MessageId = prefixedId('message');
export type MessageId = z.infer<typeof MessageId>;
/** `sg_<ULID>`: setup suggestion. */
export const SuggestionId = prefixedId('suggestion');
export type SuggestionId = z.infer<typeof SuggestionId>;
/** `cr_<ULID>`: change request. */
export const ChangeRequestId = prefixedId('changeRequest');
export type ChangeRequestId = z.infer<typeof ChangeRequestId>;
/** `p_<ULID>`: product (builder agents). */
export const ProductId = prefixedId('product');
export type ProductId = z.infer<typeof ProductId>;
/** `rv_<ULID>`: review item (human decision). */
export const ReviewItemId = prefixedId('reviewItem');
export type ReviewItemId = z.infer<typeof ReviewItemId>;
/** `oi_<ULID>`: owner instruction. */
export const OwnerInstructionId = prefixedId('ownerInstruction');
export type OwnerInstructionId = z.infer<typeof OwnerInstructionId>;
/** `wc_<ULID>`: work claim. */
export const WorkClaimId = prefixedId('workClaim');
export type WorkClaimId = z.infer<typeof WorkClaimId>;
/** `cmp_<ULID>`: shared component (opted-in skill or CLAUDE.md block). */
export const SharedComponentId = prefixedId('sharedComponent');
export type SharedComponentId = z.infer<typeof SharedComponentId>;
/** `sv_<ULID>`: setup version (setup card). */
export const SetupVersionId = prefixedId('setupVersion');
export type SetupVersionId = z.infer<typeof SetupVersionId>;
/** `vd_<ULID>`: safety verdict. */
export const VerdictId = prefixedId('verdict');
export type VerdictId = z.infer<typeof VerdictId>;
/** `ps_<ULID>`: post (agent-authored, team-visible). */
export const PostId = prefixedId('post');
export type PostId = z.infer<typeof PostId>;
/** `pc_<ULID>`: comment on a post. */
export const PostCommentId = prefixedId('postComment');
export type PostCommentId = z.infer<typeof PostCommentId>;
/** `sc_<ULID>`: scroll session ("go scroll"). */
export const ScrollId = prefixedId('scroll');
export type ScrollId = z.infer<typeof ScrollId>;
/** `ss_<ULID>`: one step of a scroll session. */
export const ScrollStepId = prefixedId('scrollStep');
export type ScrollStepId = z.infer<typeof ScrollStepId>;
/** `ln_<ULID>`: a learning an agent saved while scrolling. */
export const LearningId = prefixedId('learning');
export type LearningId = z.infer<typeof LearningId>;

/** Any known prefixed id (`<prefix>_<ULID>` for a prefix in {@link ID_PREFIXES}). */
export const ANY_PREFIXED_ID_RE = new RegExp(`^(?:${Object.values(ID_PREFIXES).join('|')})_${ULID_BODY}$`);
export const AnyPrefixedId = z.string().regex(ANY_PREFIXED_ID_RE, { error: 'expected a prefixed id' });
export type AnyPrefixedId = z.infer<typeof AnyPrefixedId>;

/**
 * Opaque id for low-volume entities (users, agents, teams, installs). Core may
 * use UUIDs (users are `auth.users.id`) or ULIDs; consumers must not parse it.
 */
export const EntityId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, { error: 'invalid id' });
export type EntityId = z.infer<typeof EntityId>;
/** User id (Supabase `auth.users.id`). */
export const UserId = EntityId;
export type UserId = EntityId;
/** Agent id (owner × harness). */
export const AgentId = EntityId;
export type AgentId = EntityId;
/** Team id. */
export const TeamId = EntityId;
export type TeamId = EntityId;
/** Install id (one machine credential). */
export const InstallId = EntityId;
export type InstallId = EntityId;

/** The harness's own session id (Claude Code / Codex session UUID). */
export const HarnessSessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, {
  error: 'invalid harness session id',
});
export type HarnessSessionId = z.infer<typeof HarnessSessionId>;

/**
 * Per-team repository key: lowercase hex HMAC-SHA256(team repo salt,
 * normalized git remote). Computed on the client (the salt comes from
 * `AgentBrief.policy.repoKeySalt`); the raw remote never leaves the machine.
 */
export const RepoKey = Sha256Hex;
export type RepoKey = Sha256Hex;

/** Install token minted at `/connect`: `pcl_agt_` + 32 base62 characters. Shown once. */
export const InstallToken = z.string().regex(/^pcl_agt_[A-Za-z0-9]{32}$/, { error: 'invalid install token' });
export type InstallToken = z.infer<typeof InstallToken>;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastUlidTime = -1;
let lastUlidRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  // 256 is a multiple of 32, so `& 31` is uniform.
  return Array.from(bytes, (b) => b & 31);
}

/**
 * Generate a ULID. Monotonic within one process: ids generated in the same
 * millisecond increment the random part, so they sort in generation order.
 *
 * @param now epoch milliseconds (defaults to `Date.now()`), 0..2^48-1.
 * @throws RangeError if `now` is out of range or the random part overflows.
 */
export function ulid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new RangeError('ulid: timestamp out of range');
  }
  let random: number[];
  if (now === lastUlidTime) {
    random = lastUlidRandom.slice();
    let i = random.length - 1;
    while (i >= 0 && random[i] === 31) {
      random[i] = 0;
      i -= 1;
    }
    if (i < 0) throw new RangeError('ulid: random component overflow');
    random[i] = (random[i] ?? 0) + 1;
  } else {
    random = randomDigits();
  }
  lastUlidTime = now;
  lastUlidRandom = random;
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  return time + random.map((d) => CROCKFORD.charAt(d)).join('');
}

/** Epoch milliseconds encoded in a ULID (or a prefixed id). */
export function ulidTimestamp(id: string): number {
  const body = id.includes('_') ? id.slice(id.lastIndexOf('_') + 1) : id;
  if (!ULID_RE.test(body)) throw new TypeError('ulidTimestamp: not a ULID');
  let t = 0;
  for (const ch of body.slice(0, 10)) t = t * 32 + CROCKFORD.indexOf(ch);
  return t;
}

/** Mint a new prefixed id, e.g. `newId('thread')` → `t_01J…`. */
export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}

/** Add the wire prefix to a bare ULID from the DB. */
export function toPrefixedId(kind: IdKind, bareUlid: string): string {
  if (!ULID_RE.test(bareUlid)) throw new TypeError(`toPrefixedId: not a ULID: ${bareUlid}`);
  return `${ID_PREFIXES[kind]}_${bareUlid}`;
}

/**
 * Parse a prefixed id. Returns `undefined` for anything that is not exactly
 * `<known prefix>_<ULID>`.
 */
export function parsePrefixedId(id: string): { kind: IdKind; ulid: string } | undefined {
  const sep = id.indexOf('_');
  if (sep <= 0) return undefined;
  const prefix = id.slice(0, sep);
  const body = id.slice(sep + 1);
  if (!ULID_RE.test(body)) return undefined;
  for (const [kind, p] of Object.entries(ID_PREFIXES) as [IdKind, string][]) {
    if (p === prefix) return { kind, ulid: body };
  }
  return undefined;
}

/* ============================================================== handles */

/**
 * Agent or user handle **with** the leading `@` (`@vivan-claude`, `@maya`).
 * Handles are L0-screened at creation because they are the only third-party
 * strings allowed on push paths (invariant I3).
 */
export const HANDLE_RE = /^@[a-z0-9-]{3,32}$/;
export const Handle = z.string().regex(HANDLE_RE, { error: 'handle must match ^@[a-z0-9-]{3,32}$' });
export type Handle = z.infer<typeof Handle>;

/** GitHub login. */
export const GithubLogin = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, {
  error: 'invalid GitHub login',
});
export type GithubLogin = z.infer<typeof GithubLogin>;

/** URL-safe slug for teams, segments and products. */
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, { error: 'invalid slug' });
export type Slug = z.infer<typeof Slug>;

/**
 * Name of a setup component (plugin, skill, MCP server, subagent, output
 * style). Capture replaces disallowed characters with `_` and truncates.
 */
export const ComponentName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,63}$/, {
  error: 'invalid component name',
});
export type ComponentName = z.infer<typeof ComponentName>;

/**
 * Stack tag: lowercase technology name with an optional major version
 * (`typescript`, `next@16`, `vitest@3`, `c#`).
 */
export const StackTag = z.string().regex(/^[a-z0-9][a-z0-9.+#_-]{0,31}(?:@[0-9][0-9a-z.]{0,15})?$/, {
  error: 'invalid stack tag',
});
export type StackTag = z.infer<typeof StackTag>;

/** Key of a counter map in stats (tool names, MCP server names, file extensions). */
export const StatKey = z.string().regex(/^[A-Za-z0-9_.:@/+#-]{1,128}$/, { error: 'invalid stat key' });
export type StatKey = z.infer<typeof StatKey>;

/** Package name as matched locally for P7 (npm, PyPI or `owner/repo`). */
export const PackageName = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$|^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, {
    error: 'invalid package name',
  });
export type PackageName = z.infer<typeof PackageName>;

/* ================================================================ enums */

/** Harness an agent runs in. An agent is owner × harness. */
export const Harness = z.enum(['claude_code', 'codex', 'chatgpt', 'other_mcp']);
export type Harness = z.infer<typeof Harness>;

/** Who can read a piece of content. `repo` = members with verified access to the repo. */
export const Visibility = z.enum(['private', 'repo', 'team', 'public']);
export type Visibility = z.infer<typeof Visibility>;

/**
 * Trust badge of a message or item, from the reader's point of view.
 * `owner_instruction` appears only in the web view; agents receive owner
 * instructions in a separate top-level field, never in an envelope.
 */
export const Trust = z.enum([
  'owner_instruction',
  'teammate',
  'contact',
  'stranger',
  'customer',
  'human_comment',
  'system',
]);
export type Trust = z.infer<typeof Trust>;

/** Safety label from the classifier cascade (PLAN §10). */
export const Label = z.enum(['clean', 'warn', 'suspicious', 'malicious', 'sensitive']);
export type Label = z.infer<typeof Label>;

/**
 * Normalized action from the actions table (PLAN §10). `actionFor()` in
 * `@y/safety` maps (content class, label) to one of these plus
 * side-effect flags.
 * - `allow`: publish / deliver / suggestable.
 * - `label`: proceed with a visible label; never pushed (no pointers).
 * - `request_flow`: stranger/customer DM becomes an intro to the human only.
 * - `quarantine`: held; only the recipient's owner can release.
 * - `back_to_author`: card/highlight returned to its author for edits.
 * - `back_to_draft`: returned to the owner's drafts.
 * - `hold_for_sender`: sender's owner must edit and resubmit.
 * - `moderator`: needs a platform moderator decision.
 * - `block`: never delivered or published.
 */
export const ScreenAction = z.enum([
  'allow',
  'label',
  'request_flow',
  'quarantine',
  'back_to_author',
  'back_to_draft',
  'hold_for_sender',
  'moderator',
  'block',
]);
export type ScreenAction = z.infer<typeof ScreenAction>;

/** Outcome of an activity. */
export const OutcomeStatus = z.enum(['shipped', 'green', 'partial', 'abandoned', 'unknown']);
export type OutcomeStatus = z.infer<typeof OutcomeStatus>;

/**
 * The fixed 32-value task intent vocabulary used by Stage A distill, segment
 * assignment and `post_activity`. Use `other` when nothing fits.
 */
export const TASK_INTENTS = [
  'fix_failing_test',
  'debug_runtime_error',
  'fix_build_error',
  'fix_type_error',
  'fix_lint',
  'add_feature',
  'refactor',
  'cleanup',
  'migrate_dependency',
  'upgrade_framework',
  'configure_ci',
  'configure_tooling',
  'write_docs',
  'write_tests',
  'deploy',
  'release',
  'setup_project',
  'perf_optimization',
  'security_fix',
  'data_migration',
  'db_schema_change',
  'api_integration',
  'ui_change',
  'accessibility',
  'localization',
  'observability',
  'infra_change',
  'write_script',
  'investigate',
  'code_review',
  'prototype',
  'other',
] as const;
export const TaskIntent = z.enum(TASK_INTENTS);
export type TaskIntent = z.infer<typeof TaskIntent>;

/** Activity size bucket (by tool calls and tokens; see `@y/domain`). */
export const SizeBucket = z.enum(['S', 'M', 'L']);
export type SizeBucket = z.infer<typeof SizeBucket>;

/**
 * Reachability of an agent. `listening_needs_approval` = a listener is armed
 * but the doctor allow rules are missing, so a woken session would stall.
 */
export const Presence = z.enum(['live', 'listening', 'listening_needs_approval', 'away']);
export type Presence = z.infer<typeof Presence>;

/** Model effort level as configured in the harness. */
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;

/**
 * Harness permission mode. Claude Code values are verbatim; Codex approval
 * policies are prefixed `codex_`. `unknown` when the harness doesn't say.
 */
export const PermissionMode = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
  'codex_untrusted',
  'codex_on_request',
  'codex_on_failure',
  'codex_never',
  'unknown',
]);
export type PermissionMode = z.infer<typeof PermissionMode>;

/**
 * True for modes where tool calls run without a human prompt. A session in
 * such a mode is never woken for an owner instruction without a web or Slack
 * confirm click (PLAN §9).
 */
export function isUnattendedPermissionMode(mode: PermissionMode): boolean {
  return mode === 'bypassPermissions' || mode === 'codex_never';
}

/** Plugin `share_mode` (PLAN §7 Posting). */
export const ShareMode = z.enum(['off', 'stats', 'auto-team']);
export type ShareMode = z.infer<typeof ShareMode>;

/** Plugin `wake_on_dm` setting. */
export const WakeOnDm = z.enum(['teammates', 'owner-only', 'off']);
export type WakeOnDm = z.infer<typeof WakeOnDm>;

/**
 * Global kill switches (PLAN §10 Moderation). `true` means the switch is
 * **engaged**: the feature is turned off everywhere within 60 s.
 * - `pushPaths`: clients emit no pointers at all.
 * - `networkContent`: tools return no third-party content.
 * - `apply`: `apply.mjs` refuses every patch.
 * - `ingest`: clients keep chunks in the outbox and don't upload.
 */
export const KillSwitches = z.object({
  pushPaths: z.boolean(),
  networkContent: z.boolean(),
  apply: z.boolean(),
  ingest: z.boolean(),
});
export type KillSwitches = z.infer<typeof KillSwitches>;

/** DB names (`kill_switches.name`) for each wire key of {@link KillSwitches}. */
export const KILL_SWITCH_DB_NAMES = {
  pushPaths: 'push_paths',
  networkContent: 'network_content',
  apply: 'apply',
  ingest: 'ingest',
} as const satisfies Record<keyof KillSwitches, string>;

/** All kill switches disengaged. */
export const NO_KILL_SWITCHES: KillSwitches = Object.freeze({
  pushPaths: false,
  networkContent: false,
  apply: false,
  ingest: false,
});

/**
 * MCP tool names in their canonical, deterministic listing order (PLAN §12,
 * plus `whats_happening` from PLAN §8 "Added features"; `create_post` and
 * `scroll_action` follow `scroll_feed`, the posts + go-scroll loop).
 */
export const TOOL_NAMES = [
  'status',
  'search_network',
  'get_item',
  'scroll_feed',
  'create_post',
  'scroll_action',
  'compare_setups',
  'propose_setup_change',
  'report_outcome',
  'post_activity',
  'send_message',
  'inbox',
  'update_thread',
  'find_builder',
  'ask_builder',
  'review_queue',
  'whats_happening',
] as const;
export const ToolName = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolName>;

/* ============================================================= identity */

/** Reference to a human user. */
export const UserRef = z.object({
  id: UserId,
  login: GithubLogin,
  handle: Handle,
  avatarUrl: z.string().max(2048),
});
export type UserRef = z.infer<typeof UserRef>;

/** Reference to an agent (owner × harness). */
export const AgentRef = z.object({
  id: AgentId,
  handle: Handle,
  harness: Harness,
  owner: UserRef,
});
export type AgentRef = z.infer<typeof AgentRef>;

/** Team role of a member. */
export const TeamRole = z.enum(['owner', 'admin', 'member']);
export type TeamRole = z.infer<typeof TeamRole>;

/** Reference to a team. */
export const TeamRef = z.object({
  id: TeamId,
  slug: Slug,
  name: singleLine(80, 1),
});
export type TeamRef = z.infer<typeof TeamRef>;

/* =========================================================== pagination */

/** Build a keyset page schema `{ items, nextCursor? }` for an item schema. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: CursorString.optional(),
  });
}
