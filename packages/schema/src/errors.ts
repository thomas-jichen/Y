/**
 * The error shape, in the two casings of the two surfaces (same codes, same
 * fields):
 *
 * - {@link ErrorBody} (camelCase) on the web JSON API and the hook REST API
 *   (UI.md §8):
 *   `{"error":{"code":"RATE_LIMITED","message":"…","retryable":true,"retryAfterS":30}}`
 * - {@link McpErrorBody} (snake_case) in MCP tool results
 *   (`{isError: true, structuredContent: <McpErrorBody>}`, PLAN §12) and on
 *   the internal MCP API between `apps/mcp` and core:
 *   `{"error":{"code":"RATE_LIMITED","message":"…","retryable":true,"retry_after_s":30}}`
 *
 * Convert with {@link toMcpErrorBody} / {@link fromMcpErrorBody}, or
 * {@link PacelineError.toMcpBody}.
 *
 * @module errors
 */
import { z } from 'zod';
import { ToolName } from './common.js';

/** Every error code Paceline returns. */
export const ErrorCode = z.enum([
  'RATE_LIMITED',
  'DM_NOT_PERMITTED',
  'QUARANTINED',
  'HELD_FOR_SENDER',
  'PAUSED_BY_OWNER',
  'STALE_SUGGESTION',
  'SCOPE_FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION',
  'UPGRADE_REQUIRED',
  'UNAUTHORIZED',
  'STEP_UP_REQUIRED',
  'CONFLICT',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * A human gesture the agent should ask its owner for. Rendered by the client
 * as fixed text next to `url` (always a Paceline web URL).
 */
export const HumanAction = z.enum([
  'review_in_web',
  'step_up',
  'reconnect',
  'upgrade_plugin',
  'accept_policy',
  'grant_permission',
  'wait_for_owner',
]);
export type HumanAction = z.infer<typeof HumanAction>;

/** Suggested next step: another tool call, or a human action at a URL. */
export const ErrorNext = z.union([
  z.strictObject({
    tool: ToolName,
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    humanAction: HumanAction,
    url: z.url(),
  }),
]);
export type ErrorNext = z.infer<typeof ErrorNext>;

/** {@link ErrorNext} in MCP casing: `{tool, args?}` or `{human_action, url}`. */
export const McpErrorNext = z.union([
  z.strictObject({
    tool: ToolName,
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    human_action: HumanAction,
    url: z.url(),
  }),
]);
export type McpErrorNext = z.infer<typeof McpErrorNext>;

/** The `error` object. `fields` maps dotted input paths to messages for `VALIDATION`. */
export const ErrorDetail = z.object({
  code: ErrorCode,
  message: z.string().min(1).max(1000),
  retryable: z.boolean(),
  retryAfterS: z.int().min(0).max(86_400).optional(),
  next: ErrorNext.optional(),
  fields: z.record(z.string().max(200), z.string().max(500)).optional(),
});
export type ErrorDetail = z.infer<typeof ErrorDetail>;

/** `{ error: ErrorDetail }`: the web and hook REST error body. */
export const ErrorBody = z.object({ error: ErrorDetail });
export type ErrorBody = z.infer<typeof ErrorBody>;

/** {@link ErrorDetail} in MCP casing (`retry_after_s`, `next.human_action`). */
export const McpErrorDetail = z.object({
  code: ErrorCode,
  message: z.string().min(1).max(1000),
  retryable: z.boolean(),
  retry_after_s: z.int().min(0).max(86_400).optional(),
  next: McpErrorNext.optional(),
  fields: z.record(z.string().max(200), z.string().max(500)).optional(),
});
export type McpErrorDetail = z.infer<typeof McpErrorDetail>;

/** `{ error: McpErrorDetail }`: `structuredContent` of an MCP error result, and internal MCP API errors. */
export const McpErrorBody = z.object({ error: McpErrorDetail });
export type McpErrorBody = z.infer<typeof McpErrorBody>;

/** Convert a web/REST error body to the MCP casing. */
export function toMcpErrorBody(body: ErrorBody): McpErrorBody {
  const { code, message, retryable, retryAfterS, next, fields } = body.error;
  const error: McpErrorDetail = { code, message, retryable };
  if (retryAfterS !== undefined) error.retry_after_s = retryAfterS;
  if (next !== undefined) {
    error.next = 'tool' in next ? next : { human_action: next.humanAction, url: next.url };
  }
  if (fields !== undefined) error.fields = fields;
  return { error };
}

/** Convert an MCP error body to the web/REST casing. */
export function fromMcpErrorBody(body: McpErrorBody): ErrorBody {
  const { code, message, retryable, retry_after_s, next, fields } = body.error;
  const error: ErrorDetail = { code, message, retryable };
  if (retry_after_s !== undefined) error.retryAfterS = retry_after_s;
  if (next !== undefined) {
    error.next = 'tool' in next ? next : { humanAction: next.human_action, url: next.url };
  }
  if (fields !== undefined) error.fields = fields;
  return { error };
}

/** HTTP status for each code on the REST and web APIs. */
export const ERROR_HTTP_STATUS = {
  RATE_LIMITED: 429,
  DM_NOT_PERMITTED: 403,
  QUARANTINED: 422,
  HELD_FOR_SENDER: 422,
  PAUSED_BY_OWNER: 409,
  STALE_SUGGESTION: 409,
  SCOPE_FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  UPGRADE_REQUIRED: 426,
  UNAUTHORIZED: 401,
  STEP_UP_REQUIRED: 401,
  CONFLICT: 409,
  INTERNAL: 500,
} as const satisfies Record<ErrorCode, number>;

/** Default `retryable` per code (callers may override, e.g. a transient CONFLICT). */
export const ERROR_DEFAULT_RETRYABLE = {
  RATE_LIMITED: true,
  DM_NOT_PERMITTED: false,
  QUARANTINED: false,
  HELD_FOR_SENDER: false,
  PAUSED_BY_OWNER: false,
  STALE_SUGGESTION: false,
  SCOPE_FORBIDDEN: false,
  NOT_FOUND: false,
  VALIDATION: false,
  UPGRADE_REQUIRED: false,
  UNAUTHORIZED: false,
  STEP_UP_REQUIRED: false,
  CONFLICT: false,
  INTERNAL: true,
} as const satisfies Record<ErrorCode, boolean>;

/** Optional parts of an error. */
export interface ErrorOptions {
  retryable?: boolean;
  retryAfterS?: number;
  next?: ErrorNext;
  fields?: Record<string, string>;
}

/** Build an {@link ErrorBody}; `retryable` defaults from {@link ERROR_DEFAULT_RETRYABLE}. */
export function makeError(code: ErrorCode, message: string, opts: ErrorOptions = {}): ErrorBody {
  const error: ErrorDetail = {
    code,
    message,
    retryable: opts.retryable ?? ERROR_DEFAULT_RETRYABLE[code],
  };
  if (opts.retryAfterS !== undefined) error.retryAfterS = opts.retryAfterS;
  if (opts.next !== undefined) error.next = opts.next;
  if (opts.fields !== undefined) error.fields = opts.fields;
  return { error };
}

/**
 * Convert a zod error into a `VALIDATION` body. `fields` keys are dotted
 * paths (`claims.0.areaGlob`); the root is `$`. Messages come from zod and
 * never echo the rejected value.
 */
export function validationError(err: z.ZodError, message = 'Invalid input'): ErrorBody {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.length === 0 ? '$' : issue.path.map(String).join('.');
    if (!(key in fields)) fields[key] = issue.message;
  }
  return makeError('VALIDATION', message, { fields });
}

/**
 * Throwable carrying an {@link ErrorBody}. Core handlers throw it; the HTTP
 * layer turns it into `status` + `toBody()`.
 */
export class PacelineError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterS: number | undefined;
  readonly next: ErrorNext | undefined;
  readonly fields: Record<string, string> | undefined;

  constructor(code: ErrorCode, message: string, opts: ErrorOptions = {}) {
    super(message);
    this.name = 'PacelineError';
    this.code = code;
    this.retryable = opts.retryable ?? ERROR_DEFAULT_RETRYABLE[code];
    this.retryAfterS = opts.retryAfterS;
    this.next = opts.next;
    this.fields = opts.fields;
  }

  /** HTTP status from {@link ERROR_HTTP_STATUS}. */
  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }

  /** The wire body. */
  toBody(): ErrorBody {
    const opts: ErrorOptions = { retryable: this.retryable };
    if (this.retryAfterS !== undefined) opts.retryAfterS = this.retryAfterS;
    if (this.next !== undefined) opts.next = this.next;
    if (this.fields !== undefined) opts.fields = this.fields;
    return makeError(this.code, this.message, opts);
  }

  /** The MCP-cased body (`structuredContent` of an `isError` tool result). */
  toMcpBody(): McpErrorBody {
    return toMcpErrorBody(this.toBody());
  }

  /** Rehydrate from a web/REST wire body. */
  static fromBody(body: ErrorBody): PacelineError {
    const { code, message, ...rest } = body.error;
    return new PacelineError(code, message, rest);
  }

  /** Rehydrate from an MCP-cased body (e.g. in `apps/mcp` after calling core's internal API). */
  static fromMcpBody(body: McpErrorBody): PacelineError {
    return PacelineError.fromBody(fromMcpErrorBody(body));
  }
}

/** Type guard for {@link ErrorBody}-shaped values. */
export function isErrorBody(value: unknown): value is ErrorBody {
  return ErrorBody.safeParse(value).success;
}

/** Type guard for {@link McpErrorBody}-shaped values. */
export function isMcpErrorBody(value: unknown): value is McpErrorBody {
  return McpErrorBody.safeParse(value).success;
}
