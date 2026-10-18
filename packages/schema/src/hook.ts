/**
 * The remaining hook REST contracts (PLAN §3 "Hook REST"): error matching
 * for P2, heartbeats, and the approved-changes feed the uploader/listener
 * stages for `apply.mjs`.
 *
 * - `POST /api/v1/hook/match`  → {@link HookMatchRequest} / {@link HookMatchResponse}
 * - `POST /api/v1/heartbeat`   → {@link HeartbeatRequest} / {@link HeartbeatResponse}
 * - `GET  /api/v1/changes`     → {@link ChangesResponse}
 * - `POST /api/v1/changes/:id/report` → {@link ChangeReport} / {@link ChangeReportResponse}
 *
 * @module hook
 */
import { z } from 'zod';
import {
  ChangeRequestId,
  HarnessSessionId,
  Harness,
  HighlightId,
  IsoTimestamp,
  PermissionMode,
  RepoKey,
  Sha256Hex,
  StackTag,
  StatKey,
  ThreadId,
  singleLine,
} from './common.js';
import { PulseSummary } from './ingest.js';
import { ChangeRequestState, Patch, SignedChange, SignedRollback } from './scroll.js';

/**
 * PostToolUseFailure → match the current error against highlights. Only the
 * normalized, redacted signature leaves the machine, and only when capture
 * is on.
 */
export const HookMatchRequest = z.object({
  v: z.literal(1),
  harness: Harness,
  sessionId: HarnessSessionId,
  signature: singleLine(300, 1),
  tool: StatKey,
  stackTags: z.array(StackTag).max(8).optional(),
  repoKey: RepoKey.optional(),
});
export type HookMatchRequest = z.infer<typeof HookMatchRequest>;

/**
 * Best match, if any. The hook emits P2 only when `score >= 0.6` and the
 * local trust gate passes for `authorTrust`; core already filters to
 * `status='active'` and `screen_action in (allow)` (labelled items are never
 * pushed).
 */
export const HookMatchResponse = z.object({
  match: z
    .object({
      highlightId: HighlightId,
      score: z.number().min(0).max(1),
      scope: z.enum(['team', 'public']),
      authorTrust: z.enum(['self', 'teammate', 'contact', 'public']),
    })
    .nullable(),
});
export type HookMatchResponse = z.infer<typeof HookMatchResponse>;

/** Listener state reported in heartbeats (drives presence). */
export const ListenerState = z.enum(['none', 'listening', 'listening_needs_approval']);
export type ListenerState = z.infer<typeof ListenerState>;

/** Heartbeat from PostToolUse (≤ 1 per 2 min) and the listener. Updates `last_event_at` and the session lease. */
export const HeartbeatRequest = z.object({
  v: z.literal(1),
  harness: Harness,
  sessionId: HarnessSessionId,
  repoKey: RepoKey.optional(),
  listener: ListenerState,
  permissionMode: PermissionMode,
  headless: z.boolean(),
  /** Threads this session recently touched (thread affinity for the lease). */
  lastThreadIds: z.array(ThreadId).max(10).optional(),
  sentAt: IsoTimestamp,
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

/** Heartbeat response. */
export const HeartbeatResponse = z.object({
  ok: z.literal(true),
  pulse: PulseSummary,
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/**
 * One approved change for this agent, ready to stage. The client verifies
 * `signed` against its keyring, checks that
 * `sha256(patchHashInput(patch)) === signed.payload.patchHash`, re-fetches
 * `GET /api/v1/changes/:id/hash` ({@link ChangeHashResponse}) over TLS and
 * compares again, then stages under `staged/<changeRequestId>`.
 */
export const ApprovedChange = z.object({
  changeRequestId: ChangeRequestId,
  patch: Patch,
  signed: SignedChange,
  approvedAt: IsoTimestamp,
});
export type ApprovedChange = z.infer<typeof ApprovedChange>;

/** `GET /api/v1/changes?state=approved` (also forced rollbacks for takedowns). */
export const ChangesResponse = z.object({
  changes: z.array(ApprovedChange).max(20),
  /** Server-forced rollbacks of taken-down components (the only network-initiated local change, I1). */
  rollbacks: z.array(z.object({ changeRequestId: ChangeRequestId, signed: SignedRollback })).max(20),
});
export type ChangesResponse = z.infer<typeof ChangesResponse>;

/** `GET /api/v1/changes/:id/hash`: the independent re-fetch of the approved hash. */
export const ChangeHashResponse = z.object({
  changeRequestId: ChangeRequestId,
  patchHash: Sha256Hex,
  state: ChangeRequestState,
});
export type ChangeHashResponse = z.infer<typeof ChangeHashResponse>;

/** Result of applying (or rolling back) a staged change. */
export const ChangeReport = z.object({
  result: z.enum(['applied', 'failed', 'conflict', 'rolled_back']),
  /** Per display path (`patchOpPath`), SHA-256 after apply. Required when `result` is `applied`. */
  postHashes: z.record(z.string().max(200), Sha256Hex).optional(),
  error: z
    .enum([
      'bad_signature',
      'expired',
      'hash_mismatch',
      'base_changed',
      'path_rejected',
      'kill_switch',
      'io_error',
      'pr_failed',
    ])
    .optional(),
  prUrl: z.url().optional(),
  at: IsoTimestamp,
});
export type ChangeReport = z.infer<typeof ChangeReport>;

/** Ack of a change report. */
export const ChangeReportResponse = z.object({ ok: z.literal(true) });
export type ChangeReportResponse = z.infer<typeof ChangeReportResponse>;
