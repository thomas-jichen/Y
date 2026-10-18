/**
 * @paceline/capture: client-side transcript parsing, stats, laps, digests,
 * setup snapshots and segment boundaries (PLAN §6–7).
 *
 * Runs inside the plugin's hook scripts (Node ≥ 20, node built-ins only; it
 * is bundled by esbuild). Pure functions except where noted (`readTranscriptDelta`
 * and `snapshotSetup*` read files). Nothing here touches the network.
 *
 * The Claude Code transcript JSONL is undocumented: parse defensively, never
 * throw on a bad line, and **de-dupe usage by `message.id`** (keep the last
 * usage per id; without this totals are ~2× too high).
 *
 * @packageDocumentation
 */
import type {
  ActivityStats,
  CommandStats,
  Harness,
  Lap,
  SegmentCloseReason,
  SetupSnapshot,
} from '@paceline/schema';

/* ============================================================ transcripts */

/**
 * Persistent read position in one transcript file (`cursors/<sessionId>.json`).
 * `offset` is a byte offset at a line boundary; `ino`/`size` detect rotation
 * or truncation.
 */
export interface TranscriptCursor {
  offset: number;
  ino?: number;
  size?: number;
}

/** Result of {@link readTranscriptDelta}. */
export interface TranscriptDelta {
  /** Complete lines (without the trailing `\n`), in file order. Empty lines are dropped. */
  lines: string[];
  /** Cursor to persist for the next read. */
  cursor: TranscriptCursor;
  /** True when the file was truncated or replaced and reading restarted at 0. */
  reset: boolean;
  /** True when `maxBytes` stopped the read before EOF; call again to continue. */
  more: boolean;
}

/** Options for {@link readTranscriptDelta}. */
export interface ReadDeltaOptions {
  /** Max bytes to read in one call (default 8 MiB). */
  maxBytes?: number;
}

/**
 * Read the lines appended to a JSONL file since `cursor`.
 *
 * - `cursor` null/undefined → read from byte 0.
 * - Reads from `cursor.offset` to EOF (or `maxBytes`), splits on `\n`, and
 *   returns only **complete** lines; a trailing partial line is left unread
 *   (the returned `cursor.offset` points at its first byte), so a line being
 *   written concurrently is picked up whole next time.
 * - A `\r` before `\n` is stripped. Invalid UTF-8 is replaced (U+FFFD), never
 *   thrown.
 * - If the file's inode differs from `cursor.ino`, or its size is smaller than
 *   `cursor.offset`, reading restarts at 0 and `reset` is true.
 * - A missing file returns `{ lines: [], cursor: cursor ?? {offset: 0}, reset: false, more: false }`.
 *
 * @throws only for I/O errors other than ENOENT.
 */
export async function readTranscriptDelta(
  path: string,
  cursor: TranscriptCursor | null | undefined,
  opts?: ReadDeltaOptions,
): Promise<TranscriptDelta> {
  throw new Error('not implemented: readTranscriptDelta');
}

/** Token usage of one assistant API response (camelCased from the transcript). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** A normalized content block. Thinking and attachments keep only their type. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; text: string }
  | { type: 'thinking' }
  | { type: 'image' }
  | { type: 'other'; rawType: string };

/**
 * One transcript record, reduced to the fields Paceline reads (PLAN §7):
 * `type`, `message.role`, `message.id`, `message.model`, `message.usage`,
 * `content[].type/name/input/is_error`, `isMeta`, `origin`, `isSidechain`,
 * `version`, `timestamp`, plus cost state when present.
 */
export interface ClaudeRecord {
  /** Record `type`; unknown types map to `other`. */
  kind: 'user' | 'assistant' | 'system' | 'summary' | 'other';
  uuid?: string;
  parentUuid?: string;
  /** ISO timestamp as written by the harness. */
  timestamp?: string;
  sessionId?: string;
  /** Harness version (`version`). */
  version?: string;
  isSidechain: boolean;
  isMeta: boolean;
  origin?: string;
  /** `message.id` (assistant records): the dedupe key for usage. */
  messageId?: string;
  role?: 'user' | 'assistant';
  model?: string;
  content: ContentBlock[];
  usage?: Usage;
  /** The record is a synthetic API error message. */
  isApiError: boolean;
  /** The record is a user interrupt marker ("[Request interrupted by user…"). */
  isInterrupt: boolean;
  /** A human-typed prompt: role user, not meta, not a tool result, not an interrupt, not sidechain. */
  isHumanPrompt: boolean;
  /** Cumulative session cost in USD, when the harness wrote cost state on this record. */
  costUsd?: number;
}

/** Result of {@link parseClaudeRecords}. */
export interface ParseResult {
  records: ClaudeRecord[];
  /** Lines that were not JSON objects or lacked a recognizable shape. */
  skipped: number;
}

/**
 * Parse Claude Code transcript lines. Tolerant: never throws; non-JSON lines,
 * non-objects and records without a `type` are counted in `skipped`. String
 * `content` is turned into one text block; tool result content arrays are
 * flattened to text (images dropped). Unknown content block types become
 * `{type:'other'}`. Field names are read defensively (`is_error` or
 * `isError`, `tool_use_id`, etc.).
 */
export function parseClaudeRecords(lines: readonly string[]): ParseResult {
  throw new Error('not implemented: parseClaudeRecords');
}

/* ================================================================== stats */

/** USD per million tokens for one model family. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Version tag of {@link PRICING}; bump whenever prices change. */
export const PRICING_VERSION = '2026-10-06';

/**
 * Prices used when the harness reports no cost (`costSource: 'estimate'`),
 * matched by model id prefix (longest prefix wins). The server recomputes
 * cost with its own table; this is for local display only.
 */
export const PRICING: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** Options for {@link computeStats}. */
export interface ComputeStatsOptions {
  /** Harness version to record (falls back to the last record's `version`, then `'0'`). */
  harnessVersion?: string;
  /** Pricing table override (tests). */
  pricing?: Readonly<Record<string, ModelPrice>>;
  /** Cost already accounted for before this delta (cost state is cumulative); default 0. */
  previousCostUsd?: number;
}

/**
 * Compute ActivityStats v1 for one delta of records.
 *
 * - **Tokens**: group assistant records by `messageId` and keep the **last**
 *   usage per id (records without an id count individually). `main` feeds
 *   input/output/cacheRead/cacheWrite; every file in `subagents` is deduped
 *   the same way and summed into `tokens.subagents`; `total` is the sum.
 * - **toolCalls**: built-in tool name → count of `tool_use` blocks in `main`
 *   (not sidechain). MCP tools (`mcp__<server>__<tool>`) go to
 *   `mcp[server][tool]` instead. Names are sanitized to `StatKey`.
 * - **skillsInvoked**: unique `Skill` tool inputs (`skill`/`name`), in order.
 * - **subagents**: count of `Task`/`Agent` tool uses; unique `subagent_type`s.
 * - **filesChanged**: from `Edit`/`MultiEdit`/`Write`/`NotebookEdit` inputs:
 *   distinct files (count), extension counts (`ts`, `json`; `none` when
 *   absent), lines added/removed estimated from old/new strings. **No paths.**
 * - **commands**: each `Bash` command classified by {@link classifyCommand}.
 * - **tests**: runs = test commands; `last` from {@link parseTestSummary} on
 *   the last test result; `greenAtEnd` = last run passed with 0 failed and no
 *   later failed test run; `confidence` 0.9 with a parsed summary, 0.5 with
 *   only an exit status, 0 without runs.
 * - **errors**: tool_result `isError` count, `isApiError` records, interrupts.
 * - **turns**: human prompts; **activeMs**: sum over turns of (last record
 *   time in the turn − prompt time); **wallMs**: last − first timestamp.
 * - **models**: unique assistant `model`s (excluding `<synthetic>`).
 * - **gitCommits**: successful `git commit` commands; **prUrlsCount**: distinct
 *   GitHub/GitLab PR URLs seen in tool results (count only, never the URL);
 *   **userCorrections**: human prompts after the first that start with a
 *   correction cue ("no", "that's wrong", "not what I", "undo", "revert", "stop").
 * - **cost**: if any record carries `costUsd`, `costUsd = last - previousCostUsd`
 *   and `costSource: 'harness'`; otherwise estimated from {@link PRICING}
 *   with `costSource: 'estimate'`.
 *
 * Pure. Empty input returns `emptyStats(harnessVersion)`.
 */
export function computeStats(
  main: readonly ClaudeRecord[],
  subagents: readonly (readonly ClaudeRecord[])[],
  opts?: ComputeStatsOptions,
): ActivityStats {
  throw new Error('not implemented: computeStats');
}

/**
 * Classify a Bash command for `stats.commands` by its first meaningful
 * program (after `cd x &&`, env assignments, `sudo`, `npx`/`pnpm exec`):
 * - `test`: vitest, jest, mocha, pytest, go test, cargo test, `npm|pnpm|yarn|bun test`, `* run test*`;
 * - `build`: tsc, vite build, next build, cargo build, go build, make, `* run build*`;
 * - `lint`: eslint, biome, prettier --check, ruff, golangci-lint, `* run lint*`, `* run typecheck`;
 * - `git`: git, gh;
 * - `install`: `npm|pnpm|yarn|bun install|add|i`, pip install, uv add, cargo add, go get, brew install;
 * - `other`: anything else.
 */
export function classifyCommand(command: string): keyof CommandStats {
  throw new Error('not implemented: classifyCommand');
}

/**
 * Parse a test runner's summary from command output (vitest, jest, mocha,
 * pytest, go test, cargo test). Returns the counts of the **last** summary in
 * the text, or `undefined` if none is recognized. `framework` is the lowercase
 * runner name.
 */
export function parseTestSummary(output: string): { passed: number; failed: number; framework: string } | undefined {
  throw new Error('not implemented: parseTestSummary');
}

/**
 * Build laps: one lap per non-empty chunk (a chunk = the records read by one
 * Stop hook). `index` counts from `firstIndex`; `startedAt` is the first
 * record timestamp of the chunk (chunks without timestamps are skipped);
 * `turns` = human prompts, `tokens` = deduped main-thread tokens,
 * `errors` = failed tool results + API errors, `toolCalls` = tool uses.
 */
export function buildLaps(chunks: readonly (readonly ClaudeRecord[])[], firstIndex = 0): Lap[] {
  throw new Error('not implemented: buildLaps');
}

/* ================================================================= digest */

/** Options for {@link buildDigest}. */
export interface DigestOptions {
  /** Token cap (≈ chars / 4). Default 24,000. */
  maxTokens?: number;
  /** Project root used to relativize paths in `Edit` lines; absolute paths outside it become `<ABS>/<basename>`. */
  projectDir?: string;
  /** Hook-provided `last_assistant_message`, used for the FINAL line when present. */
  lastAssistantMessage?: string;
}

/** A deterministic digest (not yet redacted). */
export interface Digest {
  text: string;
  approxTokens: number;
  /** True when content was dropped to fit `maxTokens`. */
  truncated: boolean;
  /** Number of error→fix windows kept. */
  errorWindows: number;
}

/**
 * Build the deterministic digest that Stage A distills (PLAN §7). Reads only
 * the fields on {@link ClaudeRecord}; drops thinking, images and attachments.
 * One entry per line, in order:
 * - `USER: <prompt ≤1000 chars>` (human prompts only)
 * - `ASSISTANT: <text ≤600 chars>`
 * - `TOOL <name>: <one-line argument>`; `Bash` command ≤300 chars;
 *   `Edit <relpath> (+N/−M)` for edits; `Read <relpath>`; MCP tools as
 *   `TOOL mcp:<server>/<tool>`
 * - `ERROR <name>: <failed result ≤800 chars>` followed by the next
 *   successful result of the same tool as `OK <name>: <≤300 chars>`
 * - `CONFIG <relpath>:` + a unified diff ≤40 lines for edits to agent config
 *   (`.claude/**`, `CLAUDE*.md`, `.mcp.json`, `AGENTS.md`)
 * - `FINAL: <last assistant message ≤600 chars>`
 * Multi-line values are collapsed to one line (`\n` → ` ⏎ `) except CONFIG diffs.
 * When over `maxTokens`, drops ASSISTANT lines first, then TOOL lines outside
 * error→fix windows, then the oldest USER lines, never ERROR/OK pairs or FINAL.
 * Redaction is **not** applied here; run `@paceline/redact` on the result.
 */
export function buildDigest(records: readonly ClaudeRecord[], opts?: DigestOptions): Digest {
  throw new Error('not implemented: buildDigest');
}

/**
 * Normalize an error message into a stable signature for trigram matching
 * (`highlight_errors.sig`, `HookMatchRequest.signature`):
 * 1. strip ANSI escapes; take the first line containing `error`, `fail`,
 *    `exception`, `panic` or an `E[A-Z]+` code, else the first non-empty line;
 * 2. lowercase; replace URLs → `<url>`, absolute and relative paths →
 *    `<path>`, UUIDs/long hex → `<hex>`, IPv4/IPv6 → `<ip>`, quoted strings
 *    longer than 24 chars → `<str>`, numbers → `<n>` (keeping error codes
 *    such as `etimedout`, `e404` and `ts2345` intact);
 * 3. collapse whitespace; trim; cap at 300 chars.
 * Deterministic and idempotent: `normalizeErrorSignature(normalizeErrorSignature(x)) === normalizeErrorSignature(x)`.
 * Returns `''` for input with no visible text.
 */
export function normalizeErrorSignature(text: string): string {
  throw new Error('not implemented: normalizeErrorSignature');
}

/* ================================================================== setup */

/** Options for {@link snapshotSetup}. */
export interface SnapshotSetupOptions {
  /** Project root (cwd of the session). */
  projectDir: string;
  /** User home directory. */
  homeDir: string;
  /** Claude config dir (default `$CLAUDE_CONFIG_DIR` or `<homeDir>/.claude`). */
  configDir?: string;
  /**
   * Redactor for descriptions and headings (pass `@paceline/redact`'s
   * `redact(...).text`). Capture has no redact dependency, so it's injected.
   */
  redactText: (text: string) => string;
  /** Model reported by the session (overrides settings). */
  model?: string;
}

/**
 * Snapshot the Claude Code setup as allowlisted metadata (PLAN §7):
 * - plugins: enabled plugins from settings (`enabledPlugins`) with versions
 *   from the installed-plugins registry;
 * - skills: `SKILL.md` under user, project and enabled plugin skill dirs:
 *   name, scope, redacted frontmatter `description` (≤300), sha256 of the file;
 * - mcpServers: from `.mcp.json`, settings and `~/.claude.json` (project
 *   scope): name, scope, transport, and `publicHost` only for http/sse/ws URLs
 *   whose host is a public DNS name (never localhost, IPs, `.local`,
 *   `.internal`). **Never env, headers, args or URL paths.**
 * - hooks: event, matcher, type, sha256 of command/url/prompt;
 * - claudeMd: sha256 over user `CLAUDE.md`, project `CLAUDE.md`,
 *   `.claude/CLAUDE.md` (load order, joined with `"\n\0\n"`) and their
 *   redacted H2 headings; `CLAUDE.local.md` excluded;
 * - model, effort, permissionMode (`defaultMode`), outputStyle, subagent names
 *   (`.claude/agents/*.md`, user and project).
 * Missing or unparsable files are skipped. Names are sanitized to
 * `ComponentName` (invalid chars → `_`, cut to 64). Arrays are sorted by name.
 * The result always validates against `SetupSnapshot`.
 */
export async function snapshotSetup(opts: SnapshotSetupOptions): Promise<SetupSnapshot> {
  throw new Error('not implemented: snapshotSetup');
}

/** Options for {@link snapshotCodexSetup}. */
export interface SnapshotCodexSetupOptions {
  projectDir: string;
  /** `$CODEX_HOME` or `~/.codex`. */
  codexHome: string;
  redactText: (text: string) => string;
  model?: string;
}

/**
 * Snapshot a Codex setup: `config.toml` (model, `model_reasoning_effort` →
 * effort, `approval_policy` → `codex_*` permission mode, `[mcp_servers.*]`
 * names and transports), skills under `<codexHome>/skills`, and `AGENTS.md`
 * (user and project) as `claudeMd`. Same allowlist rules as
 * {@link snapshotSetup}; uses a minimal built-in TOML reader (tables, strings,
 * booleans, numbers, arrays of strings).
 */
export async function snapshotCodexSetup(opts: SnapshotCodexSetupOptions): Promise<SetupSnapshot> {
  throw new Error('not implemented: snapshotCodexSetup');
}

/* ================================================================== codex */

/** Result of {@link parseCodexRollout}. */
export interface CodexRolloutResult {
  stats: ActivityStats;
  /** Records normalized to the Claude shape so {@link buildDigest} works unchanged. */
  digestRecords: ClaudeRecord[];
  sessionId?: string;
  harnessVersion?: string;
  model?: string;
  skipped: number;
}

/**
 * Parse Codex rollout lines (`~/.codex/sessions/**\/rollout-*.jsonl`):
 * `session_meta` (id, cli version), `turn_context` (model, approval policy),
 * `response_item` (messages, function calls/outputs → tool_use/tool_result),
 * `event_msg` (user messages, token counts, errors). Tokens come from the
 * **last** `token_count` event's `total_token_usage` (cumulative; not summed).
 * `costSource` is always `estimate`. Tolerant like {@link parseClaudeRecords}.
 */
export function parseCodexRollout(lines: readonly string[]): CodexRolloutResult {
  throw new Error('not implemented: parseCodexRollout');
}

/* =============================================================== segments */

/** A segment closes after 30 minutes without a heartbeat. */
export const SEGMENT_IDLE_MS = 30 * 60 * 1000;
/** A segment is capped at 4 hours. */
export const SEGMENT_CAP_MS = 4 * 60 * 60 * 1000;

/** Local segment state per session (`state/segments/<sessionId>.json`). */
export interface SegmentState {
  sessionId: string;
  harness: Harness;
  segmentIndex: number;
  /** Next chunk sequence number (monotonic per session across segments). */
  seq: number;
  startedAt: number;
  lastEventAt: number;
  closed: boolean;
}

/** Something that happened in the session. */
export type SegmentEvent =
  | { kind: 'stop'; at: number }
  | { kind: 'heartbeat'; at: number }
  | { kind: 'clear'; at: number }
  | { kind: 'session_end'; at: number }
  | { kind: 'explicit_post'; at: number }
  | { kind: 'sweep'; at: number };

/** Outcome of {@link applySegmentEvent}. */
export interface SegmentTransition {
  state: SegmentState;
  /** Close the current segment with this reason (send `close` on the next chunk). */
  close: SegmentCloseReason | null;
  /** A new segment started (index incremented) after the close. */
  opened: boolean;
}

/** Fresh state for a new session. */
export function newSegmentState(sessionId: string, harness: Harness, at: number): SegmentState {
  throw new Error('not implemented: newSegmentState');
}

/**
 * Apply an event:
 * - `clear`, `session_end`, `explicit_post` → close with that reason
 *   (`session_end` → `session_end`, `clear` → `clear`, `explicit_post` →
 *   `explicit_post`); `clear` and `explicit_post` open a new segment,
 *   `session_end` marks the state closed;
 * - any event at `at - lastEventAt >= SEGMENT_IDLE_MS` first closes the old
 *   segment with `idle_timeout` and opens a new one starting at `at`;
 * - any event at `at - startedAt >= SEGMENT_CAP_MS` closes with `cap` and opens a new one;
 * - `sweep` (SessionStart finding a stale, unclosed state) closes with `sweep`;
 * - otherwise only `lastEventAt` advances.
 * Pure; never mutates `state`.
 */
export function applySegmentEvent(state: SegmentState, event: SegmentEvent): SegmentTransition {
  throw new Error('not implemented: applySegmentEvent');
}

/* ============================================================== repo keys */

/**
 * Normalize a git remote so all spellings of one repo compare equal:
 * `git@github.com:Acme/API.git`, `https://github.com/acme/api`,
 * `ssh://git@github.com/acme/api.git` → `github.com/acme/api`. Lowercases
 * host and path, strips credentials, port, `.git` and trailing slashes.
 * Returns `undefined` for anything that is not a recognizable remote.
 */
export function normalizeGitRemote(remote: string): string | undefined {
  throw new Error('not implemented: normalizeGitRemote');
}

/**
 * `repoKey` = lowercase hex HMAC-SHA256(key = base64url-decoded `salt`
 * from `AgentBrief.policy.repoKeySalt`, message = `normalizeGitRemote(remote)`).
 * Returns `undefined` when the remote doesn't normalize. Uses `node:crypto`.
 */
export function computeRepoKey(remote: string, salt: string): string | undefined {
  throw new Error('not implemented: computeRepoKey');
}

/**
 * Sanitize a tool/server/skill name into a `StatKey`: keep
 * `[A-Za-z0-9_.:@/+#-]`, replace anything else with `_`, cut to 128 chars;
 * `''` becomes `_`.
 */
export function sanitizeStatKey(name: string): string {
  throw new Error('not implemented: sanitizeStatKey');
}
