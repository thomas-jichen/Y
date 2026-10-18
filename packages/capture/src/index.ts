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
 * Codex rollout parsing and Codex setup snapshots are CUT for v0 and still
 * throw `not implemented`.
 *
 * @packageDocumentation
 */
import type { CodexRolloutResult, SnapshotCodexSetupOptions } from './types.js';
import type { SetupSnapshot } from '@paceline/schema';

export * from './types.js';
export { parseClaudeRecords, readTranscriptDelta } from './transcript.js';
export { buildLaps, classifyCommand, computeStats, parseTestSummary, sanitizeStatKey } from './stats.js';
export { buildDigest, normalizeErrorSignature } from './digest.js';
export { snapshotSetup } from './setup.js';
export { applySegmentEvent, computeRepoKey, newSegmentState, normalizeGitRemote } from './segments.js';

/**
 * Snapshot a Codex setup: `config.toml` (model, `model_reasoning_effort` →
 * effort, `approval_policy` → `codex_*` permission mode, `[mcp_servers.*]`
 * names and transports), skills under `<codexHome>/skills`, and `AGENTS.md`
 * (user and project) as `claudeMd`. Same allowlist rules as
 * {@link snapshotSetup}; uses a minimal built-in TOML reader (tables, strings,
 * booleans, numbers, arrays of strings).
 */
export async function snapshotCodexSetup(_opts: SnapshotCodexSetupOptions): Promise<SetupSnapshot> {
  throw new Error('not implemented: snapshotCodexSetup');
}

/**
 * Parse Codex rollout lines (`~/.codex/sessions/**\/rollout-*.jsonl`):
 * `session_meta` (id, cli version), `turn_context` (model, approval policy),
 * `response_item` (messages, function calls/outputs → tool_use/tool_result),
 * `event_msg` (user messages, token counts, errors). Tokens come from the
 * **last** `token_count` event's `total_token_usage` (cumulative; not summed).
 * `costSource` is always `estimate`. Tolerant like {@link parseClaudeRecords}.
 */
export function parseCodexRollout(_lines: readonly string[]): CodexRolloutResult {
  throw new Error('not implemented: parseCodexRollout');
}
