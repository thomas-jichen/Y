/**
 * @paceline/safety: the classifier cascade and the content-safety helpers
 * (PLAN §10).
 *
 * The classifier is **triage, not the boundary** (I8): envelopes (I2),
 * pointer-only push (I3), default-deny DMs (I4) and signed human-approved
 * patches (I1) carry the load. A missing or failed verdict never raises
 * trust.
 *
 * Cascade: {@link normalizeUntrusted} → {@link l0Scan} (< 10 ms, inline
 * everywhere) → L2 {@link Judge} (`claude-haiku-5-5`, effort low,
 * structured output) when required → {@link actionFor}.
 *
 * No network except inside {@link createAnthropicJudge}'s judge calls.
 *
 * @packageDocumentation
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  ActionDecision,
  ContentClass,
  Envelope,
  EnvelopeParts,
  JudgeVerdict,
  L0Result,
  Label,
  Screen,
  StaticFinding,
  StaticOutcome,
  Verdict,
} from '@paceline/schema';

/* ========================================================= normalization */

/** Result of {@link normalizeUntrusted}. */
export interface NormalizedText {
  text: string;
  /** Number of invisible / bidi-control characters removed. */
  removedInvisible: number;
  /** True if anything changed. */
  changed: boolean;
}

/**
 * Normalize third-party text before screening, storage for display, and
 * enveloping:
 * 1. Unicode NFKC;
 * 2. strip invisible and bidi-control characters (`INVISIBLE_CHARS_SOURCE`
 *    in `@paceline/schema`);
 * 3. CRLF/CR → LF; remove C0 controls except `\t` and `\n`, and DEL;
 * 4. collapse runs of more than 2 blank lines to 2.
 * Delimiter escaping is **not** done here; `encodeUntrustedContent` in the
 * schema does it when the content is enveloped. Idempotent.
 */
export function normalizeUntrusted(text: string): NormalizedText {
  throw new Error('not implemented: normalizeUntrusted');
}

/* ==================================================================== L0 */

/**
 * L0 scan (< 10 ms for 4,000 chars) on **normalized** text. Rule families
 * (`L0Category`):
 * - `injection_phrase`: "ignore (all|previous) instructions", "you are now",
 *   "system prompt", "developer mode", role-tag spoofs (`</system>`,
 *   `[INST]`, `<|im_start|>`), fake "Paceline:" pointer text;
 * - `agent_imperative`: imperatives addressed to the reading agent ("as an
 *   AI agent you must…", "run the following", "call the send_message tool");
 * - `blob`: base64/hex runs ≥ 200 chars, data URIs;
 * - `url`: URLs whose host is not on the allowlist (github.com, npmjs.com,
 *   pypi.org, docs domains of claimed products, the Paceline host);
 * - `secret`: `@paceline/redact` `scanSecrets` hits;
 * - `command`: {@link lintCommands} hits;
 * - `invisible_chars`: only if the input still contains them (callers that
 *   skipped normalization);
 * - `code_shape`: fenced code, import/require lines, stack of `;`/`{}` lines;
 * - `handle`: a would-be handle that fails the handle regex (handles class).
 * `label`: `malicious` for a block-severity injection + command combination,
 * `suspicious` for any block-severity finding, `warn` for warn findings,
 * `sensitive` when the only block findings are secrets, else `clean`.
 * `needsL2`: true when {@link requiresL2} says so for the class, or label ≠ clean.
 * Findings carry spans, never the matched text.
 */
export function l0Scan(text: string, contentClass: ContentClass): L0Result {
  throw new Error('not implemented: l0Scan');
}

/** Whether a content class always goes to L2 (setups, stranger DMs and builder answers do). */
export function requiresL2(contentClass: ContentClass): boolean {
  throw new Error('not implemented: requiresL2');
}

/** One command-linter hit. `rule` ids are stable (`cmd.curl_pipe_sh`). */
export interface CommandFinding {
  rule: string;
  severity: 'warn' | 'block';
  start: number;
  end: number;
}

/**
 * The command linter (PLAN §10 L0): finds dangerous shell patterns in any
 * text (fenced or inline): `curl|wget … | sh|bash|zsh|python`,
 * `base64 -d|--decode … |`, `eval`, `printenv`/`env` dumps, `cat .env*`,
 * `~/.ssh`, `.aws/credentials`, writes (`>`, `>>`, `tee`, `cp`, `mv`, `sed -i`)
 * to agent config or rc files (`.claude/`, `CLAUDE*.md`, `.mcp.json`,
 * `AGENTS.md`, `~/.codex/`, `~/.bashrc`, `~/.zshrc`, `~/.profile`,
 * `~/.paceline`), `git config --global`, `--no-verify`, `push --force` /
 * `-f`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `sudo`,
 * `--dangerously-skip-permissions`. All `block` except `sudo`,
 * `--no-verify` and `push --force` (`warn`). Also used by the PreToolUse
 * guard on Bash commands when the session is tainted.
 */
export function lintCommands(text: string): CommandFinding[] {
  throw new Error('not implemented: lintCommands');
}

/* ======================================================== static checks */

/** Result of {@link staticCheckSkill}. */
export interface StaticReport {
  outcome: StaticOutcome;
  findings: StaticFinding[];
  /**
   * The content as it would be applied: frontmatter keys `allowed-tools`,
   * `hooks` and `context` removed (each removal is an SC010 warn finding).
   * `null` when the outcome is `fail` (never applied).
   */
  sanitized: string | null;
}

/** Limits enforced by SC015. */
export const STATIC_LIMITS = { maxBytes: 32_000, maxLines: 600, maxLineLength: 2_000 } as const;

/**
 * Static checks SC001–SC018 (`STATIC_RULES` in the schema) over a shared
 * skill or CLAUDE.md block. Line numbers are 1-based (0 = whole file).
 * `outcome` is `fail` if any finding has severity `fail`, `warn` if any
 * `warn`, else `pass`. Security-themed prose (explaining an attack) is not
 * flagged unless it contains an executable instruction. Deterministic.
 */
export function staticCheckSkill(content: string, kind: 'skill' | 'claude_md_block' = 'skill'): StaticReport {
  throw new Error('not implemented: staticCheckSkill');
}

/* =================================================================== DLP */

/** One DLP hit (never includes the matched text). */
export interface DlpFinding {
  kind: 'secret' | 'code_fence' | 'code_shape' | 'repo_path';
  rule: string;
  start: number;
  end: number;
}

/** Options for {@link dlpScan}. */
export interface DlpOptions {
  /** Repo-relative paths of the sender's repo (from the client); matches are `repo_path` hits. */
  repoPaths?: readonly string[];
  /** Same-team sends may allow short code (≤ 5 lines); cross-owner sends never do. */
  allowShortCode?: boolean;
}

/** Result of {@link dlpScan}. */
export interface DlpResult {
  /** False → the send is `held_for_sender` (I10). */
  ok: boolean;
  findings: DlpFinding[];
}

/**
 * Outbound DLP on every agent-authored body (I10): secrets (`scanSecrets`),
 * code fences, code shape (≥ 3 consecutive lines that look like code:
 * import/require/def/class/function, braces and semicolons, indentation
 * blocks), and repo-path matches. `ok` is false on any secret, any repo path,
 * and any code unless `allowShortCode` and the code is ≤ 5 lines.
 */
export function dlpScan(body: string, opts?: DlpOptions): DlpResult {
  throw new Error('not implemented: dlpScan');
}

/* ================================================================= judge */

/** What the judge sees: normalized text and its class, nothing about the viewer (I9). */
export interface JudgeInput {
  text: string;
  contentClass: ContentClass;
}

/** A judge call's result. */
export interface JudgeResult {
  verdict: JudgeVerdict;
  /** The model stopped with `refusal`; `verdict` is then `malicious` (CLAUDE.md). */
  refusal: boolean;
  model: string;
  latencyMs: number;
  costUsd: number;
}

/** The L2 judge. Implementations must never throw for a refusal; they throw only for transport/API/parse failures. */
export interface Judge {
  readonly name: string;
  judge(input: JudgeInput): Promise<JudgeResult>;
}

/** Options for {@link createAnthropicJudge}. */
export interface AnthropicJudgeOptions {
  /** Injected client (tests, custom base URL). Default `new Anthropic()` (reads `ANTHROPIC_API_KEY`). */
  client?: Anthropic;
  /** Default `claude-haiku-5-5`. */
  model?: string;
  /** Default 15,000 ms; a timeout throws. */
  timeoutMs?: number;
  /** Default 1,024. */
  maxTokens?: number;
}

/**
 * L2 judge on the Anthropic API: `messages.create` with
 * `output_config: { effort: 'low', format: { type: 'json_schema', schema: judgeVerdictJsonSchema } }`,
 * a fixed system prompt that treats the content as untrusted data, the
 * content wrapped as an encoded JSON string, **no tools, no sampling params,
 * no forced tool_choice**. `stop_reason: "refusal"` → `{label:'malicious',
 * category:'none', confidence:1, rationale:'refusal', spans:[]}` with
 * `refusal: true`. The JSON is validated with the schema's `JudgeVerdict`;
 * invalid JSON throws. Cost is computed from `usage` at Haiku 5.5 prices.
 */
export function createAnthropicJudge(opts?: AnthropicJudgeOptions): Judge {
  throw new Error('not implemented: createAnthropicJudge');
}

/** Options for {@link createMockJudge}. */
export interface MockJudgeOptions {
  /** Case-insensitive substring → label; first match wins. Defaults cover injection, exfil and secret phrases. */
  rules?: readonly { contains: string; label: Label; category?: JudgeVerdict['category'] }[];
  /** Simulate failure: `'throw'` rejects every call, `'refuse'` returns refusals. */
  mode?: 'normal' | 'throw' | 'refuse';
  /** Fixed latency to report. Default 1. */
  latencyMs?: number;
}

/**
 * Deterministic offline judge (`PACELINE_LLM=mock`). With default rules:
 * "ignore previous instructions"/"exfiltrate"/"cat .env"/"send your api key"
 * → malicious; "curl" + "| sh" → suspicious; "password"/"secret" → warn;
 * otherwise clean with confidence 0.6. Cost 0.
 */
export function createMockJudge(opts?: MockJudgeOptions): Judge {
  throw new Error('not implemented: createMockJudge');
}

/* =============================================================== cascade */

/** An item to screen. */
export interface ScreenItem {
  contentClass: ContentClass;
  /** Prefixed id of the item (stored on the verdict). */
  contentId: string;
  text: string;
  /** Force L2 regardless of class and L0 (e.g. public visibility: stricter screen). */
  forceL2?: boolean;
}

/** Dependencies of {@link screen}. */
export interface ScreenDeps {
  /** L2 judge; absent → L2 is treated as failed when required. */
  judge?: Judge;
  /** Clock (ms). Default `Date.now`. */
  now?: () => number;
  /** Id generator for the verdict. Default `newId('verdict')`. */
  newVerdictId?: () => string;
}

/** Output of {@link screen}. */
export interface ScreenOutcome {
  verdict: Verdict;
  decision: ActionDecision;
  /** Chip for readers and envelopes. */
  screen: Screen;
  /** Normalized text (what should be stored and displayed). */
  normalized: NormalizedText;
}

/**
 * Run the cascade:
 * 1. normalize; 2. L0; 3. L2 if `forceL2`, {@link requiresL2}, or L0 label ≠ clean;
 * 4. final label = the more severe of L0 and L2 (`LABEL_SEVERITY`);
 *    if L2 was needed but failed or no judge: `l2Error` is set and the label
 *    is at least **`suspicious`** for `dm_stranger`, `builder_answer`,
 *    `shared_component`, `card`, `highlight`, and at least L0's label for the
 *    other classes (teammate DMs retry upstream). Trust never rises (I8);
 * 5. `decision = actionFor(contentClass, label)`.
 * Never throws for judge failures.
 */
export async function screen(item: ScreenItem, deps: ScreenDeps): Promise<ScreenOutcome> {
  throw new Error('not implemented: screen');
}

/**
 * The actions table (PLAN §10), plus rows for the remaining classes:
 *
 * | class | clean | warn | suspicious | malicious | sensitive |
 * |---|---|---|---|---|---|
 * | card, highlight | allow | label (noPush) | back_to_author | block + flagSender | back_to_draft |
 * | comment | allow | label | quarantine | block | hold_for_sender |
 * | dm_teammate | allow | label | quarantine | block + notifyOwner | hold_for_sender |
 * | dm_stranger | request_flow | quarantine | quarantine | block + flagSender | hold_for_sender |
 * | shared_component | allow (if static pass) | label | moderator | block + takedown | block |
 * | builder_answer | allow | label | quarantine | block + flagSender | hold_for_sender |
 * | owner_instruction | allow | label | hold_for_sender | block | hold_for_sender |
 * | stats | allow | allow | back_to_draft | block | back_to_draft |
 *
 * `noPush` is true for every `label` action and every non-`allow` action.
 */
export function actionFor(contentClass: ContentClass, label: Label): ActionDecision {
  throw new Error('not implemented: actionFor');
}

/**
 * Build an envelope for third-party content: deep-normalizes every string in
 * `parts.content` with {@link normalizeUntrusted}, then calls the schema's
 * `buildEnvelope` (which encodes `untrustedContent` and picks the fixed note).
 * The only sanctioned way to put third-party content into a tool result (I2).
 */
export function makeEnvelope<T>(parts: EnvelopeParts<T>): Envelope<T> {
  throw new Error('not implemented: makeEnvelope');
}
