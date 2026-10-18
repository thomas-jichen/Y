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
 * structured output) when required and configured → {@link actionFor}.
 *
 * No network except inside {@link createAnthropicJudge}'s judge calls.
 *
 * @packageDocumentation
 */
export { normalizeUntrusted, deepNormalize, type NormalizedText } from './normalize.js';
export { lintCommands, isDiscussionContext, COMMAND_RULES, type CommandFinding } from './commands.js';
export { l0Scan, requiresL2, labelFromFindings, findSecrets, DEFAULT_ALLOWED_HOSTS, type L0Options, type SecretSpan } from './l0.js';
export { staticCheckSkill, STATIC_LIMITS, type StaticReport } from './static.js';
export { dlpScan, DLP_SHORT_CODE_MAX_LINES, type DlpFinding, type DlpOptions, type DlpResult } from './dlp.js';
export {
  createAnthropicJudge,
  createMockJudge,
  JudgeError,
  JUDGE_SYSTEM_PROMPT,
  DEFAULT_MOCK_JUDGE_RULES,
  type AnthropicJudgeOptions,
  type Judge,
  type JudgeErrorKind,
  type JudgeInput,
  type JudgeResult,
  type MockJudgeOptions,
  type MockJudgeRule,
} from './judge.js';
export { screen, actionFor, makeEnvelope, type ScreenDeps, type ScreenItem, type ScreenOutcome } from './cascade.js';
