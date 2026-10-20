/**
 * `POST /api/v1/ingest`: one chunk from the client uploader (PLAN §6–7).
 * Chunks are already redacted on the machine (pass 1), idempotent on
 * `(sessionId, seq)`, and rate limited to one per 5 s per session.
 *
 * Distillation (zero-cost hosting): by default the client distills on the
 * user's machine with their own subscription (`claude -p --safe-mode --model
 * haiku …`, see `BriefPolicy.distiller`) and uploads only the validated,
 * redacted result in {@link IngestChunk.distilled}; the digest text then
 * never leaves the machine. The server distills from `digest` only when
 * `ANTHROPIC_API_KEY` is set and the policy says `server`.
 *
 * @module ingest
 */
import { z } from 'zod';
import {
  ActivityId,
  CursorString,
  Count,
  HarnessSessionId,
  Harness,
  PermissionMode,
  RepoKey,
  Semver,
  Sha256Hex,
  StatKey,
  VersionString,
  IsoTimestamp,
  ModelId,
  multiLine,
  singleLine,
} from './common.js';
import { ActivityCard, HighlightDraft } from './activity.js';
import { SetupSnapshot } from './setup.js';
import { ActivityStats, Lap } from './stats.js';

/** Ingest schema version. */
export const INGEST_VERSION = 1 as const;

/** Max digest text per chunk (~24k tokens). */
export const DIGEST_MAX_CHARS = 100_000;

/** Max error episodes per chunk. */
export const MAX_ERROR_EPISODES = 20;

/** A redaction rule id as reported in receipts (`github_pat`, `entropy`, `identity_user`). */
export const RedactionRuleId = z.string().regex(/^[a-z0-9_]{1,40}$/);
export type RedactionRuleId = z.infer<typeof RedactionRuleId>;

/**
 * Grammar of redaction markers left in redacted text: `<REDACTED:<rule>>`,
 * `<USER>`, `<EMAIL>`, `<HOST>`, `<ORG>`, `<PROJECT>`, `<TERM>`. Distill
 * validators drop LLM output that still contains one (PLAN §7). Non-global;
 * `@y/redact` re-exports it as `MARKER_RE`.
 */
export const REDACTION_MARKER_RE = /<(?:REDACTED:[a-z0-9_]{1,40}|USER|EMAIL|HOST|ORG|PROJECT|TERM)>/;

/** Redaction report: hits per rule, and whether the digest was dropped (fail closed at > 5 hits). */
export const RedactionReport = z.object({
  hitsByRule: z.record(RedactionRuleId, Count),
  dropped: z.boolean(),
});
export type RedactionReport = z.infer<typeof RedactionReport>;

/**
 * Digest delta for this chunk. When `redaction.dropped` is true the text is
 * empty (stats only) and the report still travels for the upload receipt.
 * `sha256` is over the UTF-8 `text`.
 */
export const DigestPayload = z
  .object({
    text: multiLine(DIGEST_MAX_CHARS),
    sha256: Sha256Hex,
    redaction: RedactionReport,
  })
  .refine((d) => !d.redaction.dropped || d.text.length === 0, {
    error: 'a dropped digest must have empty text',
    path: ['text'],
  });
export type DigestPayload = z.infer<typeof DigestPayload>;

/**
 * One failed-tool episode: normalized signature (for trigram match), the
 * tool, and a redacted excerpt (≤800 chars). Only sent when capture is on.
 */
export const ErrorEpisode = z.object({
  signature: singleLine(300, 1),
  tool: StatKey,
  excerpt: multiLine(800),
});
export type ErrorEpisode = z.infer<typeof ErrorEpisode>;

/** Why a segment closed. */
export const SegmentCloseReason = z.enum([
  'session_end',
  'clear',
  'idle_timeout',
  'explicit_post',
  'cap',
  'sweep',
]);
export type SegmentCloseReason = z.infer<typeof SegmentCloseReason>;

/**
 * Setup reference. `snapshot` is sent only when the client hasn't uploaded
 * this `hash` before; the server stores one `setup_versions` row per
 * (agent, hash) and ignores repeated snapshots.
 */
export const IngestSetup = z.object({
  hash: Sha256Hex,
  snapshot: SetupSnapshot.optional(),
});
export type IngestSetup = z.infer<typeof IngestSetup>;

/**
 * Result of distilling a closed segment on the user's machine (Stage A card
 * plus up to three Stage B highlights, both from the local CLI with
 * `--json-schema` set to `activityCardJsonSchema` / `highlightsJsonSchema`).
 * The client validates it with these schemas, drops drafts that fail the
 * distill validators, and runs redaction pass 1 over every string before
 * upload; the server runs pass 2 and screens it like a server distill.
 */
export const LocalDistill = z.object({
  mode: z.literal('local'),
  /** Which CLI produced it. */
  runner: z.enum(['claude_cli', 'codex_cli']),
  /** Model the CLI reported (`claude-haiku-5-5`). */
  model: ModelId,
  /** Version tag of the local prompt + schema bundle (`distill-v1`). */
  promptVersion: z.string().regex(/^[a-z0-9._-]{1,40}$/),
  card: ActivityCard,
  highlights: z.array(HighlightDraft).max(3),
  /** Pass-1 redaction hits over the distilled strings (for the upload receipt). */
  redaction: RedactionReport,
});
export type LocalDistill = z.infer<typeof LocalDistill>;

/**
 * An ingest chunk. `statsDelta` is additive since the previous chunk of the
 * same segment (fold with `mergeStats`); `laps` are the laps closed in this
 * chunk. `distilled` may only ride on a closing chunk (`close` set), and
 * with it any `digest` must have empty text (the redaction report may still
 * travel for the receipt).
 */
export const IngestChunk = z.object({
  v: z.literal(INGEST_VERSION),
  harness: Harness,
  harnessVersion: VersionString,
  pluginVersion: Semver,
  sessionId: HarnessSessionId,
  seq: Count,
  segmentIndex: Count,
  repoKey: RepoKey.optional(),
  statsDelta: ActivityStats,
  laps: z.array(Lap).max(50).optional(),
  digest: DigestPayload.optional(),
  setup: IngestSetup.optional(),
  errorEpisodes: z.array(ErrorEpisode).max(MAX_ERROR_EPISODES),
  close: z.object({ reason: SegmentCloseReason }).optional(),
  distilled: LocalDistill.optional(),
  headless: z.boolean(),
  permissionMode: PermissionMode,
  sentAt: IsoTimestamp,
}).superRefine((c, ctx) => {
  if (c.distilled && !c.close) {
    ctx.addIssue({ code: 'custom', path: ['distilled'], message: 'distilled requires a closing chunk (close)' });
  }
  if (c.distilled && c.digest && c.digest.text.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['digest', 'text'], message: 'digest text must be empty when distilled locally' });
  }
});
export type IngestChunk = z.infer<typeof IngestChunk>;

/** Pulse summary piggybacked on hook responses. */
export const PulseSummary = z.object({
  unread: Count,
  cursor: CursorString,
});
export type PulseSummary = z.infer<typeof PulseSummary>;

/**
 * Ingest response. `accepted: false` with `duplicate: true` for a replayed
 * `(sessionId, seq)` (the client deletes it from the outbox either way).
 * `activityId` is set once the segment has an activity row.
 */
export const IngestResponse = z.object({
  accepted: z.boolean(),
  duplicate: z.boolean().optional(),
  activityId: ActivityId.optional(),
  pulse: PulseSummary,
  /** Repo gating: nothing was stored because the session's repo is not linked to the posting team. */
  dropped: z.enum(['repo_not_linked']).optional(),
});
export type IngestResponse = z.infer<typeof IngestResponse>;
