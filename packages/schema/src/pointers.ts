/**
 * Pointers: the only thing allowed on push paths (hook stdout /
 * additionalContext, Stop block reasons, asyncRewake stderr). Invariant I3:
 * a pointer is `{template_id, params}` and params are only integers, prefixed
 * ids, screened handles or enums. Text is rendered on the client from local
 * templates (`@y/pointers`), never sent by the server.
 *
 * The pointer object is agent-facing, so it uses snake_case (like MCP tool
 * inputs and outputs) everywhere it appears: `AgentBrief.pointers`,
 * `PulseResponse.wake.pointer`, and locally rendered P7 pointers.
 *
 * Every params object is strict: unknown keys are rejected, so free text can
 * never ride along.
 *
 * @module pointers
 */
import { z } from 'zod';
import {
  ActivityId,
  ChangeRequestId,
  Handle,
  HighlightId,
  ProductId,
  SharedComponentId,
  ThreadId,
} from './common.js';

/** Pointer template ids. */
export const POINTER_TEMPLATE_IDS = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'] as const;
export const PointerTemplateId = z.enum(POINTER_TEMPLATE_IDS);
export type PointerTemplateId = z.infer<typeof PointerTemplateId>;

/** What each template means (for docs, logs and tests; not rendered). */
export const POINTER_MEANINGS = {
  P0: 'Keepalive: connected, nothing waiting.',
  P1: 'Unread DMs.',
  P2: 'A highlight matches the error the agent just hit.',
  P3: 'A setup change was approved, applied, rolled back or failed.',
  P4: 'An owner instruction is waiting.',
  P5: 'Drafts or other items await the human owner’s review.',
  P6: 'A go-scroll setup suggestion is ready.',
  P7: 'The builder of local dependency #N is on Y (matched locally).',
  P8: 'A newly applied skill needs /reload-skills.',
  P9: 'Content the agent used or applied was taken down.',
} as const satisfies Record<PointerTemplateId, string>;

/** Counts on push paths: 1..999. Producers clamp larger counts to 999. */
const SmallCount = z.int().min(1).max(999);

/** P0 keepalive: no params. */
export const P0Params = z.strictObject({});
/** P1 unread DMs: count, optional most recent sender and thread. */
export const P1Params = z.strictObject({
  count: SmallCount,
  handle: Handle.optional(),
  thread_id: ThreadId.optional(),
});
/** P2 highlight match: id, match score in percent (≥60 to be pushed), scope. */
export const P2Params = z.strictObject({
  highlight_id: HighlightId,
  score: z.int().min(60).max(100),
  scope: z.enum(['team', 'public']),
});
/** P3 change request state change. */
export const P3Params = z.strictObject({
  change_request_id: ChangeRequestId,
  state: z.enum(['approved', 'applied', 'rolled_back', 'failed', 'conflict']),
});
/** P4 owner instruction waiting. */
export const P4Params = z.strictObject({
  count: SmallCount,
  thread_id: ThreadId.optional(),
});
/** P5 items awaiting the human's review. */
export const P5Params = z.strictObject({
  count: SmallCount,
});
/** P6 suggestions ready. */
export const P6Params = z.strictObject({
  count: SmallCount,
});
/**
 * P7 builder exists for the client's own dependency at `dep_index` (an index
 * into the client's local dependency list; the name never leaves the
 * machine, the client substitutes it when rendering).
 */
export const P7Params = z.strictObject({
  dep_index: z.int().min(0).max(9999),
  product_id: ProductId,
});
/** P8 reload skills after an applied change. */
export const P8Params = z.strictObject({
  change_request_id: ChangeRequestId,
});
/** P9 takedown of something the agent used or applied. */
export const P9Params = z.strictObject({
  item_id: z.union([HighlightId, SharedComponentId, ChangeRequestId, ActivityId]),
  rollback: z.enum(['scheduled', 'none']),
});

/** Params schema per template id. */
export const POINTER_PARAMS = {
  P0: P0Params,
  P1: P1Params,
  P2: P2Params,
  P3: P3Params,
  P4: P4Params,
  P5: P5Params,
  P6: P6Params,
  P7: P7Params,
  P8: P8Params,
  P9: P9Params,
} as const satisfies Record<PointerTemplateId, z.ZodType>;

/** Params type for template `T`. */
export type PointerParams<T extends PointerTemplateId> = z.infer<(typeof POINTER_PARAMS)[T]>;

const variant = <T extends PointerTemplateId>(id: T) =>
  z.strictObject({ template_id: z.literal(id), params: POINTER_PARAMS[id] });

/** A pointer: discriminated by `template_id`, with strict params. */
export const Pointer = z.discriminatedUnion('template_id', [
  variant('P0'),
  variant('P1'),
  variant('P2'),
  variant('P3'),
  variant('P4'),
  variant('P5'),
  variant('P6'),
  variant('P7'),
  variant('P8'),
  variant('P9'),
]);
export type Pointer = z.infer<typeof Pointer>;

/** Pointer for a specific template. */
export type PointerOf<T extends PointerTemplateId> = Extract<Pointer, { template_id: T }>;

/** Build and validate a pointer (throws `ZodError` on bad params). */
export function makePointer<T extends PointerTemplateId>(templateId: T, params: PointerParams<T>): PointerOf<T> {
  return Pointer.parse({ template_id: templateId, params }) as PointerOf<T>;
}

/** Max characters of rendered pointer text the SessionStart hook prints (PLAN §6). */
export const SESSION_START_POINTER_BUDGET_CHARS = 800;
