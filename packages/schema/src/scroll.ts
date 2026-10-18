/**
 * Go-scroll contracts: typed setup suggestions, patches, change requests and
 * the signed change payload (PLAN §8, UI.md §4, invariant I1).
 *
 * A suggestion shown to an agent ({@link SetupSuggestion}, `scroll_feed`)
 * carries **typed fields only**, never author free text, and is snake_case
 * like the rest of the MCP surface (exactly the PLAN §8 field names). The
 * human approval page ({@link ChangeRequest}) is the web (camelCase) view.
 * Patches are rendered deterministically by server code, approved by a
 * human against their exact `patchHash`, signed by core (Ed25519) and
 * applied by `apply.mjs`, never by the model. The patch and signing payloads
 * travel on the hook REST API (camelCase).
 *
 * @module scroll
 */
import { z } from 'zod';
import {
  AgentId,
  AgentRef,
  ChangeRequestId,
  ComponentName,
  Count,
  Handle,
  IsoTimestamp,
  Label,
  Probability,
  RepoKey,
  Sha256Hex,
  Slug,
  SuggestionId,
  TaskIntent,
  multiLine,
} from './common.js';
import { canonicalJson } from './canonical.js';
import { CapabilityTag } from './llm.js';
import { Screen, StaticFinding, StaticOutcome } from './safety.js';

/** Suggestion kind. */
export const SuggestionKind = z.enum(['add_skill', 'claude_md_block', 'workflow_tip']);
export type SuggestionKind = z.infer<typeof SuggestionKind>;

/**
 * Where a change lands:
 * - `user`: `~/.claude/skills/<slug>/SKILL.md` (or `~/.codex/skills/…`);
 * - `local`: a managed block in `CLAUDE.local.md` (or `AGENTS.md` for Codex);
 * - `project_pr`: a branch + PR in the repo, so the team's review is the gate.
 */
export const ChangeTarget = z.enum(['user', 'local', 'project_pr']);
export type ChangeTarget = z.infer<typeof ChangeTarget>;

/** Where the evidence comes from. Scroll reports always say which. */
export const EvidenceScope = z.enum(['team', 'public-aggregate']);
export type EvidenceScope = z.infer<typeof EvidenceScope>;

/**
 * Measured evidence for a suggestion (agent-facing, `setup_suggestions.evidence`).
 * `median_tokens_delta` is a fraction (−0.31 = 31% fewer tokens).
 */
export const SuggestionEvidence = z.object({
  segment: Slug,
  source_success_wilson: Probability,
  source_n: Count,
  your_success: Probability,
  your_n: Count,
  median_tokens_delta: z.number().min(-1).max(10),
  distinct_owners: Count,
  scope: EvidenceScope,
});
export type SuggestionEvidence = z.infer<typeof SuggestionEvidence>;

/* =============================================================== patches */

const SKILL_SLUG = '[a-z0-9][a-z0-9-]{1,63}';

/** User-level skill file paths (`target: user`). */
export const USER_SKILL_PATH_RE = new RegExp(`^~/\\.(?:claude|codex)/skills/${SKILL_SLUG}/SKILL\\.md$`);
/** Project skill file paths (`target: project_pr`). */
export const PROJECT_SKILL_PATH_RE = new RegExp(`^\\.claude/skills/${SKILL_SLUG}/SKILL\\.md$`);

/** A path `create_file` may write. Anything else is rejected before signing and again by apply. */
export const AllowedCreatePath = z
  .string()
  .refine((p) => USER_SKILL_PATH_RE.test(p) || PROJECT_SKILL_PATH_RE.test(p), {
    error: 'create_file path must be a SKILL.md under ~/.claude/skills, ~/.codex/skills or .claude/skills',
  });
export type AllowedCreatePath = z.infer<typeof AllowedCreatePath>;

/** Files that may hold a Paceline managed block. */
export const ManagedBlockFile = z.enum(['CLAUDE.local.md', 'AGENTS.md']);
export type ManagedBlockFile = z.infer<typeof ManagedBlockFile>;

/** Expected pre-state of a target: `absent`, or the SHA-256 of its current content. */
export const PatchPrecondition = z.union([z.literal('absent'), z.object({ sha256: Sha256Hex })]);
export type PatchPrecondition = z.infer<typeof PatchPrecondition>;

/** Max content size of one op (also SC015). */
export const PATCH_CONTENT_MAX = 32_000;

/**
 * One patch operation:
 * - `create_file`: write `content` at an allowed SKILL.md path (frontmatter
 *   `allowed-tools`/`hooks`/`context` already stripped by the server; apply
 *   strips again and rejects `` !`cmd` `` lines);
 * - `managed_block`: replace (or insert) the block delimited by
 *   `<!-- paceline:begin <blockId> -->` / `<!-- paceline:end <blockId> -->`
 *   in `CLAUDE.local.md` or `AGENTS.md`. `expect` refers to the block's
 *   current content (or `absent`).
 * `sha256` is the hash of `content` (UTF-8).
 */
export const PatchOp = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('create_file'),
    path: AllowedCreatePath,
    content: multiLine(PATCH_CONTENT_MAX, 1),
    sha256: Sha256Hex,
    expect: PatchPrecondition,
  }),
  z.strictObject({
    op: z.literal('managed_block'),
    file: ManagedBlockFile,
    blockId: Slug,
    content: multiLine(PATCH_CONTENT_MAX),
    sha256: Sha256Hex,
    expect: PatchPrecondition,
  }),
]);
export type PatchOp = z.infer<typeof PatchOp>;

/**
 * A complete patch. `patchHash = sha256(patchHashInput(patch))` (lowercase
 * hex). Target/op compatibility is enforced:
 * - `user` → only `create_file` at `~/.claude/skills/…` or `~/.codex/skills/…`;
 * - `local` → only `managed_block`;
 * - `project_pr` → `create_file` at `.claude/skills/…` and/or `managed_block` in `AGENTS.md`.
 */
export const Patch = z
  .strictObject({
    v: z.literal(1),
    target: ChangeTarget,
    ops: z.array(PatchOp).min(1).max(5),
  })
  .superRefine((patch, ctx) => {
    patch.ops.forEach((op, i) => {
      let ok: boolean;
      if (patch.target === 'user') ok = op.op === 'create_file' && USER_SKILL_PATH_RE.test(op.path);
      else if (patch.target === 'local') ok = op.op === 'managed_block';
      else ok = op.op === 'create_file' ? PROJECT_SKILL_PATH_RE.test(op.path) : op.file === 'AGENTS.md';
      if (!ok) ctx.addIssue({ code: 'custom', path: ['ops', i], message: `op not allowed for target ${patch.target}` });
    });
  });
export type Patch = z.infer<typeof Patch>;

/** The exact string whose SHA-256 is the patch hash: `"paceline-patch-v1\n" + canonicalJson(patch)`. */
export function patchHashInput(patch: Patch): string {
  return `paceline-patch-v1\n${canonicalJson(patch)}`;
}

/** Display path of an op (`~/.claude/skills/x/SKILL.md`, `CLAUDE.local.md#block`). */
export function patchOpPath(op: PatchOp): string {
  return op.op === 'create_file' ? op.path : `${op.file}#${op.blockId}`;
}

/* =========================================================== suggestions */

/** Fields-only preview of a patch (no content); agent-facing. */
export const PatchPreview = z.object({
  patch_hash: Sha256Hex,
  files: z
    .array(
      z.object({
        path: z.string().max(200),
        op: z.enum(['create_file', 'managed_block']),
        lines: Count,
        bytes: Count,
      }),
    )
    .max(5),
});
export type PatchPreview = z.infer<typeof PatchPreview>;

/**
 * A setup suggestion as an agent sees it (`scroll_feed`). Typed fields only:
 * the component's name is a screened {@link ComponentName}; its content is
 * visible to humans on the web only. Sources: `setup_suggestions`
 * (capability_tags, applies_to_intents, evidence, static_outcome,
 * screen_label, patch_hash) joined to `shared_components` (name,
 * content_hash) and the author agent's handle; `targets` and
 * `patch_preview.files` are computed from `kind` and `patch`.
 */
export const SetupSuggestion = z.object({
  id: SuggestionId,
  kind: SuggestionKind,
  component: z.object({
    name: ComponentName,
    version_hash: Sha256Hex,
    author: Handle,
    capability_tags: z.array(CapabilityTag).max(8),
    applies_to_intents: z.array(TaskIntent).max(6),
  }),
  evidence: SuggestionEvidence,
  risk: z.object({
    static: StaticOutcome,
    verdict: Label,
  }),
  targets: z.array(ChangeTarget).min(1).max(3),
  patch_preview: PatchPreview,
});
export type SetupSuggestion = z.infer<typeof SetupSuggestion>;

/* ======================================================= change requests */

/** Change request lifecycle. */
export const ChangeRequestState = z.enum([
  'pending_approval',
  'approved',
  'applied',
  'failed',
  'rejected',
  'rolled_back',
  'expired',
]);
export type ChangeRequestState = z.infer<typeof ChangeRequestState>;

/** One file in the approval diff (UI.md §4). `before`/`after` are full texts. */
export const ChangeFile = z.object({
  path: z.string().max(200),
  op: z.enum(['create_file', 'managed_block']),
  before: z.string().max(PATCH_CONTENT_MAX * 4).optional(),
  after: z.string().max(PATCH_CONTENT_MAX * 4),
});
export type ChangeFile = z.infer<typeof ChangeFile>;

/** A change request as the human approval page sees it (UI.md §4). */
export const ChangeRequest = z.object({
  id: ChangeRequestId,
  agent: AgentRef,
  state: ChangeRequestState,
  target: ChangeTarget,
  suggestion: z.object({
    id: SuggestionId,
    kind: SuggestionKind,
    component: z.object({
      name: ComponentName,
      author: AgentRef,
      versionHash: Sha256Hex,
      capabilityTags: z.array(CapabilityTag).max(8),
    }),
    evidence: z.object({
      segment: Slug,
      sourceSuccess: Probability,
      sourceN: Count,
      yourSuccess: Probability,
      yourN: Count,
      medianTokensDelta: z.number().min(-1).max(10),
      distinctOwners: Count,
      scope: EvidenceScope,
    }),
  }),
  files: z.array(ChangeFile).max(5),
  staticFindings: z.array(StaticFinding).max(200),
  screen: Screen,
  /** POST this back on approve ("Approve exactly this"). */
  patchHash: Sha256Hex,
  /** Non-zero only for `project_pr`. */
  affects: z.object({ teammates: Count, ci: z.boolean() }),
  takesEffect: z.enum(['now', 'next_session', 'after_reload_skills']),
  appliedAt: IsoTimestamp.optional(),
  postHashes: z.record(z.string().max(200), Sha256Hex).optional(),
  prUrl: z.url().optional(),
});
export type ChangeRequest = z.infer<typeof ChangeRequest>;

/** Signing key id (`signing_keys.kid`, `keys/keyring.json`). */
export const KeyId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
export type KeyId = z.infer<typeof KeyId>;

/**
 * What core signs when a human approves a change. `exp` is Unix seconds;
 * `repoKey` is null for `user` targets.
 */
export const SignedChangePayload = z.strictObject({
  crId: ChangeRequestId,
  patchHash: Sha256Hex,
  agentId: AgentId,
  repoKey: RepoKey.nullable(),
  exp: z.int().positive(),
  kid: KeyId,
});
export type SignedChangePayload = z.infer<typeof SignedChangePayload>;

/** Signed change: payload + Ed25519 signature (base64url) over {@link signedChangeMessage}. */
export const SignedChange = z.object({
  payload: SignedChangePayload,
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/, { error: 'expected a base64url Ed25519 signature' }),
});
export type SignedChange = z.infer<typeof SignedChange>;

/** The exact string signed: `"paceline-cr-v1\n" + canonicalJson(payload)`. */
export function signedChangeMessage(payload: SignedChangePayload): string {
  return `paceline-cr-v1\n${canonicalJson(payload)}`;
}

/**
 * What core signs to force a rollback of a taken-down component (P9). Kept
 * distinct from {@link SignedChangePayload} (different message prefix) so an
 * approval signature can never be replayed as a rollback or vice versa.
 */
export const SignedRollbackPayload = z.strictObject({
  crId: ChangeRequestId,
  patchHash: Sha256Hex,
  agentId: AgentId,
  reason: z.enum(['takedown', 'revoked_key']),
  exp: z.int().positive(),
  kid: KeyId,
});
export type SignedRollbackPayload = z.infer<typeof SignedRollbackPayload>;

/** Signed rollback: payload + Ed25519 signature over {@link signedRollbackMessage}. */
export const SignedRollback = z.object({
  payload: SignedRollbackPayload,
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/, { error: 'expected a base64url Ed25519 signature' }),
});
export type SignedRollback = z.infer<typeof SignedRollback>;

/** The exact string signed for a rollback: `"paceline-rb-v1\n" + canonicalJson(payload)`. */
export function signedRollbackMessage(payload: SignedRollbackPayload): string {
  return `paceline-rb-v1\n${canonicalJson(payload)}`;
}

/** Keyring entry shipped in `plugins/claude-code/keys/keyring.json`. */
export const KeyringEntry = z.object({
  kid: KeyId,
  alg: z.literal('Ed25519'),
  /** Raw 32-byte public key, base64url. */
  pub: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  status: z.enum(['active', 'next', 'retired', 'revoked']),
});
export type KeyringEntry = z.infer<typeof KeyringEntry>;

/** The keyring file. */
export const Keyring = z.object({ v: z.literal(1), keys: z.array(KeyringEntry).min(1).max(10) });
export type Keyring = z.infer<typeof Keyring>;

/** Default lifetime of a signed change (`exp - now`), seconds. */
export const SIGNED_CHANGE_TTL_S = 7 * 24 * 3600;
