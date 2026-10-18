/**
 * Shared types and constants of @paceline/capture.
 * @module types
 */
import type { ActivityStats, Harness, SegmentCloseReason } from '@paceline/schema';

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
  /**
   * Line counts from `toolUseResult.structuredPatch` (Edit/MultiEdit/Write
   * results), when the harness wrote one. Exact; preferred over estimates.
   */
  patch?: { linesAdded: number; linesRemoved: number };
}

/** Result of {@link parseClaudeRecords}. */
export interface ParseResult {
  records: ClaudeRecord[];
  /** Lines that were not JSON objects or lacked a recognizable shape. */
  skipped: number;
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


/** Options for {@link snapshotCodexSetup}. */
export interface SnapshotCodexSetupOptions {
  projectDir: string;
  /** `$CODEX_HOME` or `~/.codex`. */
  codexHome: string;
  redactText: (text: string) => string;
  model?: string;
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



/* ============================================================== repo keys */



