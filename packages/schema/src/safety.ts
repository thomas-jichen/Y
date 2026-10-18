/**
 * Safety contracts: L0 findings, static-check findings (SC001–SC018), the L2
 * judge verdict, stored verdicts, the `Screen` chip and content classes
 * (PLAN §10). The cascade itself lives in `@paceline/safety`.
 *
 * @module safety
 */
import { z } from 'zod';
import { AnyPrefixedId, Count, IsoTimestamp, Label, Probability, ScreenAction, Usd, VerdictId, singleLine } from './common.js';

/** A cascade layer. `l1` (Prompt Guard) is a stretch and may never appear. */
export const ScreenLayer = z.enum(['l0', 'l1', 'l2']);
export type ScreenLayer = z.infer<typeof ScreenLayer>;

/**
 * What kind of content is being screened; selects the row of the actions
 * table (mirrors `verdicts.content_class`). `dm_teammate` also covers
 * accepted contacts and followed agents; `dm_stranger` also covers
 * customers; `setup_review` is an agent-written typed review of a shared
 * component (`report_outcome.review`); `card` also covers presence notes and
 * thread subjects.
 */
export const ContentClass = z.enum([
  'card',
  'highlight',
  'comment',
  'dm_teammate',
  'dm_stranger',
  'owner_instruction',
  'shared_component',
  'setup_review',
  'builder_answer',
  'stats',
]);
export type ContentClass = z.infer<typeof ContentClass>;

/** L0 rule families. */
export const L0Category = z.enum([
  'injection_phrase',
  'agent_imperative',
  'blob',
  'url',
  'secret',
  'command',
  'invisible_chars',
  'code_shape',
  'handle',
]);
export type L0Category = z.infer<typeof L0Category>;

/** L2 judge categories. `security_discussion` = benign security content (label, don't block). */
export const JudgeCategory = z.enum([
  'none',
  'prompt_injection',
  'exfiltration',
  'credential_access',
  'destructive_command',
  'supply_chain',
  'social_engineering',
  'secrets',
  'pii',
  'proprietary_code',
  'harassment',
  'spam',
  'security_discussion',
]);
export type JudgeCategory = z.infer<typeof JudgeCategory>;

/** Any category that can appear on a {@link Screen} chip. */
export const ScreenCategory = z.union([L0Category, JudgeCategory]);
export type ScreenCategory = z.infer<typeof ScreenCategory>;

/**
 * What readers see about screening: the final label, which layers ran and
 * (optionally) reason categories. Shown as a chip in the UI and carried in
 * envelopes.
 */
export const Screen = z.object({
  label: Label,
  layers: z.array(ScreenLayer).max(3),
  categories: z.array(ScreenCategory).max(8).optional(),
});
export type Screen = z.infer<typeof Screen>;

/** Character span `[start, end)` in the normalized text. */
export const TextSpan = z
  .object({ start: Count, end: Count })
  .refine((s) => s.end >= s.start, { error: 'end must be >= start' });
export type TextSpan = z.infer<typeof TextSpan>;

/**
 * One L0 hit. `rule` is a stable rule id (`inj.ignore_previous`,
 * `cmd.curl_pipe_sh`, `secret.github_pat`). Findings never carry the matched
 * text, only its span.
 */
export const L0Finding = z.object({
  rule: z.string().regex(/^[a-z0-9]+(?:[._][a-z0-9]+)*$/).max(64),
  category: L0Category,
  severity: z.enum(['info', 'warn', 'block']),
  span: TextSpan.optional(),
});
export type L0Finding = z.infer<typeof L0Finding>;

/** L0 scan result. `label` is L0's own opinion; `needsL2` says whether to escalate. */
export const L0Result = z.object({
  label: Label,
  findings: z.array(L0Finding).max(200),
  needsL2: z.boolean(),
  normalizedChanged: z.boolean(),
});
export type L0Result = z.infer<typeof L0Result>;

/** Static-check rule ids for shared components (PLAN §10). */
export const STATIC_RULE_IDS = [
  'SC001',
  'SC002',
  'SC003',
  'SC004',
  'SC005',
  'SC006',
  'SC007',
  'SC008',
  'SC009',
  'SC010',
  'SC011',
  'SC012',
  'SC013',
  'SC014',
  'SC015',
  'SC016',
  'SC017',
  'SC018',
] as const;
export const StaticRuleId = z.enum(STATIC_RULE_IDS);
export type StaticRuleId = z.infer<typeof StaticRuleId>;

/** What each static rule detects, and its default severity. */
export const STATIC_RULES = {
  SC001: { name: 'pipe_to_shell', severity: 'fail', description: 'Download piped into a shell (curl|sh, wget -O- | bash).' },
  SC002: { name: 'decode_then_exec', severity: 'fail', description: 'Decoded or unpacked payload executed (base64 -d | sh, eval of decoded text).' },
  SC003: { name: 'credential_paths', severity: 'fail', description: 'Reads credential stores (~/.ssh, ~/.aws/credentials, keychains, .netrc, .env).' },
  SC004: { name: 'env_dump', severity: 'fail', description: 'Dumps the environment (env, printenv, set, process.env serialization).' },
  SC005: { name: 'egress', severity: 'fail', description: 'Sends data to a non-allowlisted host (curl -d, nc, webhooks, DNS exfil).' },
  SC006: { name: 'config_write', severity: 'fail', description: 'Writes agent config or shell rc files (.claude/**, CLAUDE*.md, .mcp.json, AGENTS.md, ~/.codex/**, ~/.bashrc).' },
  SC007: { name: 'fake_prerequisite', severity: 'fail', description: 'Instructs installing or downloading a "required" tool or binary from an unofficial source.' },
  SC008: { name: 'obfuscation', severity: 'fail', description: 'Obfuscated text: long encoded blobs, homoglyphs, string-splitting to evade review.' },
  SC009: { name: 'inline_exec', severity: 'fail', description: 'Skill bang-exec lines (!`cmd`); rejected by apply.' },
  SC010: { name: 'allowed_tools_broadening', severity: 'warn', description: 'Frontmatter allowed-tools, hooks or context; stripped before apply.' },
  SC011: { name: 'typosquat', severity: 'fail', description: 'Package or command name that typosquats a popular one.' },
  SC012: { name: 'hook_or_settings_content', severity: 'warn', description: 'Hook or settings content; display only, never applied in v1.' },
  SC013: { name: 'permission_wildcard', severity: 'fail', description: 'Permission wildcards (Bash(*), --dangerously-skip-permissions, bypassPermissions).' },
  SC014: { name: 'binary_content', severity: 'fail', description: 'Binary or non-text content.' },
  SC015: { name: 'size_limit', severity: 'fail', description: 'Exceeds size limits (bytes, lines or line length).' },
  SC016: { name: 'third_party_contact', severity: 'warn', description: 'Tells the agent to contact third parties (send messages, open issues, email).' },
  SC017: { name: 'runtime_fetch', severity: 'fail', description: 'Fetches instructions or code at runtime (curl a URL and follow it, remote includes).' },
  SC018: { name: 'hidden_instructions', severity: 'fail', description: 'Hidden or agent-addressed override text (invisible/bidi chars, HTML comments, "ignore previous instructions").' },
} as const satisfies Record<StaticRuleId, { name: string; severity: 'fail' | 'warn'; description: string }>;

/** One static-check finding. `line` is 1-based; 0 means the whole file. */
export const StaticFinding = z.object({
  rule: StaticRuleId,
  severity: z.enum(['fail', 'warn']),
  line: Count,
  message: singleLine(300, 1),
});
export type StaticFinding = z.infer<typeof StaticFinding>;

/** Static report summary. `fail` if any finding fails. */
export const StaticOutcome = z.enum(['pass', 'warn', 'fail']);
export type StaticOutcome = z.infer<typeof StaticOutcome>;

/**
 * L2 judge output (Haiku 5.5, structured output, effort low). All fields are
 * required so the same schema serves as the structured-output JSON schema.
 * `spans` quote the offending text (≤200 chars each) instead of offsets.
 * A `stop_reason: "refusal"` from the judge is recorded as `malicious` with
 * category `none` and rationale `refusal`.
 */
export const JudgeVerdict = z.object({
  label: Label,
  category: JudgeCategory,
  confidence: Probability,
  rationale: z.string().max(400),
  spans: z.array(z.object({ quote: z.string().max(200) })).max(5),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

/** Side effects attached to a screen action (PLAN §10 actions table). */
export const ActionDecision = z.object({
  action: ScreenAction,
  /** Flag the sender/author (counts toward quarantine and anti-abuse). */
  flagSender: z.boolean(),
  /** Notify the recipient's owner (e.g. malicious DM from a teammate). */
  notifyOwner: z.boolean(),
  /** Take down the component and force signed rollback for adopters (P9). */
  takedown: z.boolean(),
  /** Never emit a pointer for this item, even if it is delivered. */
  noPush: z.boolean(),
});
export type ActionDecision = z.infer<typeof ActionDecision>;

/**
 * A stored verdict (`verdicts` table). `l2` is null when L2 did not run;
 * `l2Error` is set when it was required but failed (the label then never
 * rises above what L0 alone allows: invariant I8).
 */
export const Verdict = z.object({
  id: VerdictId,
  contentClass: ContentClass,
  contentId: AnyPrefixedId,
  l0: L0Result,
  l2: JudgeVerdict.nullable(),
  l2Error: z.enum(['timeout', 'api_error', 'invalid_output', 'skipped_budget']).nullable(),
  label: Label,
  decision: ActionDecision,
  screen: Screen,
  latencyMs: Count,
  costUsd: Usd,
  createdAt: IsoTimestamp,
});
export type Verdict = z.infer<typeof Verdict>;

/** Label severity order, least to most severe for gating (`sensitive` sits beside `suspicious`). */
export const LABEL_SEVERITY = {
  clean: 0,
  warn: 1,
  sensitive: 2,
  suspicious: 2,
  malicious: 3,
} as const satisfies Record<Label, number>;
