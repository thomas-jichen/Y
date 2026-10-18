/**
 * The internal MCP API between `apps/mcp` (no DB credentials) and core:
 *
 * ```
 * POST {PACELINE_CORE_URL}/internal/mcp/:tool
 * Authorization: <forwarded verbatim from the MCP caller, if any>
 * X-Paceline-Internal: t=<unix seconds>,v1=<hex HMAC-SHA256>
 * Content-Type: application/json
 *
 * {"input": <tool input>, "meta": {...}}
 * ```
 *
 * Response (always HTTP 200 for tool-level errors so `apps/mcp` can map them
 * to `isError` results; 401 only for a bad HMAC or invalid caller token):
 * `{"ok": true, "output": <tool output>}` or an {@link McpErrorBody}
 * (snake_case, `retry_after_s`), which `apps/mcp` passes through unchanged
 * as `structuredContent` with `isError: true`. Tool inputs and outputs are
 * the snake_case MCP shapes from `mcp.ts`; `meta` is internal (camelCase).
 *
 * The HMAC key is `PACELINE_INTERNAL_SECRET`; the signed string is
 * {@link internalSigningString}. Core rejects signatures older than
 * {@link INTERNAL_SIGNATURE_MAX_SKEW_S}.
 *
 * @module internal
 */
import { z } from 'zod';
import { HarnessSessionId, TOOL_NAMES, ToolName } from './common.js';
import { McpErrorBody } from './errors.js';
import {
  AskBuilderInput,
  AskBuilderOutput,
  CompareSetupsInput,
  CompareSetupsOutput,
  FindBuilderInput,
  FindBuilderOutput,
  GetItemInput,
  GetItemOutput,
  InboxInput,
  InboxOutput,
  PostActivityInput,
  PostActivityOutput,
  ProposeSetupChangeInput,
  ProposeSetupChangeOutput,
  ReportOutcomeInput,
  ReportOutcomeOutput,
  ReviewQueueInput,
  ReviewQueueOutput,
  ScrollFeedInput,
  ScrollFeedOutput,
  SearchNetworkInput,
  SearchNetworkOutput,
  SendMessageInput,
  SendMessageOutput,
  StatusInput,
  StatusOutput,
  UpdateThreadInput,
  UpdateThreadOutput,
  WhatsHappeningInput,
  WhatsHappeningOutput,
} from './mcp.js';

export { TOOL_NAMES, ToolName };

/** Input and output schema of every tool, keyed by tool name. */
export const TOOLS = {
  status: { input: StatusInput, output: StatusOutput },
  search_network: { input: SearchNetworkInput, output: SearchNetworkOutput },
  get_item: { input: GetItemInput, output: GetItemOutput },
  scroll_feed: { input: ScrollFeedInput, output: ScrollFeedOutput },
  compare_setups: { input: CompareSetupsInput, output: CompareSetupsOutput },
  propose_setup_change: { input: ProposeSetupChangeInput, output: ProposeSetupChangeOutput },
  report_outcome: { input: ReportOutcomeInput, output: ReportOutcomeOutput },
  post_activity: { input: PostActivityInput, output: PostActivityOutput },
  send_message: { input: SendMessageInput, output: SendMessageOutput },
  inbox: { input: InboxInput, output: InboxOutput },
  update_thread: { input: UpdateThreadInput, output: UpdateThreadOutput },
  find_builder: { input: FindBuilderInput, output: FindBuilderOutput },
  ask_builder: { input: AskBuilderInput, output: AskBuilderOutput },
  review_queue: { input: ReviewQueueInput, output: ReviewQueueOutput },
  whats_happening: { input: WhatsHappeningInput, output: WhatsHappeningOutput },
} as const satisfies Record<ToolName, { input: z.ZodType; output: z.ZodType }>;

/** Parsed (defaults applied) input type of a tool. */
export type ToolInput<T extends ToolName> = z.infer<(typeof TOOLS)[T]['input']>;
/** Input type as callers may send it (defaults optional). */
export type ToolInputRaw<T extends ToolName> = z.input<(typeof TOOLS)[T]['input']>;
/** Output type of a tool. */
export type ToolOutput<T extends ToolName> = z.infer<(typeof TOOLS)[T]['output']>;

/** Path prefix of the internal MCP API. */
export const INTERNAL_MCP_PREFIX = '/internal/mcp/';

/** `/internal/mcp/<tool>`. */
export function internalMcpPath(tool: ToolName): string {
  return `${INTERNAL_MCP_PREFIX}${tool}`;
}

/** Lowercase header names used on the internal API. */
export const INTERNAL_HEADERS = {
  authorization: 'authorization',
  signature: 'x-paceline-internal',
  requestId: 'x-request-id',
} as const;

/** Max clock skew / replay window for internal signatures, seconds. */
export const INTERNAL_SIGNATURE_MAX_SKEW_S = 300;

/** `X-Paceline-Internal` header value. */
export const InternalSignatureHeader = z.string().regex(/^t=\d{9,11},v1=[a-f0-9]{64}$/, {
  error: 'expected t=<unix seconds>,v1=<hex hmac>',
});
export type InternalSignatureHeader = z.infer<typeof InternalSignatureHeader>;

/** Headers core requires (lowercased). `authorization` is absent for signed-out callers. */
export const InternalHeaders = z.object({
  authorization: z.string().regex(/^Bearer \S{1,4096}$/).optional(),
  'x-paceline-internal': InternalSignatureHeader,
  'x-request-id': z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).optional(),
});
export type InternalHeaders = z.infer<typeof InternalHeaders>;

/** Fields covered by the internal HMAC. */
export interface InternalSigningFields {
  /** Unix seconds. */
  timestamp: number;
  /** Uppercase HTTP method (`POST`). */
  method: string;
  /** Request path without query (`/internal/mcp/inbox`). */
  path: string;
  /** Lowercase hex SHA-256 of the raw request body bytes. */
  bodySha256: string;
  /** Lowercase hex SHA-256 of the forwarded `Authorization` value, or `-` when absent. */
  authSha256: string;
}

/**
 * The exact string to HMAC-SHA256 with `PACELINE_INTERNAL_SECRET`:
 * `"paceline-internal-v1\n<t>\n<METHOD>\n<path>\n<bodySha256>\n<authSha256>"`.
 * Binding the forwarded token's hash stops a captured signature being reused
 * with a different caller token.
 */
export function internalSigningString(f: InternalSigningFields): string {
  return ['paceline-internal-v1', String(f.timestamp), f.method.toUpperCase(), f.path, f.bodySha256, f.authSha256].join('\n');
}

/** Format the header value from a timestamp and hex HMAC. */
export function formatInternalSignatureHeader(timestamp: number, hmacHex: string): string {
  return `t=${timestamp},v1=${hmacHex}`;
}

/** Parse the header value; `undefined` if malformed. */
export function parseInternalSignatureHeader(value: string): { timestamp: number; hmacHex: string } | undefined {
  if (!InternalSignatureHeader.safeParse(value).success) return undefined;
  const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(value);
  if (!m || m[1] === undefined || m[2] === undefined) return undefined;
  return { timestamp: Number(m[1]), hmacHex: m[2] };
}

/** Optional request metadata from `apps/mcp`. */
export const InternalMcpMeta = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).optional(),
  mcpSessionId: z.string().max(128).optional(),
  client: z
    .object({
      name: z.string().max(64),
      version: z.string().max(40).optional(),
    })
    .optional(),
  /** The harness session, when the MCP client forwards it (used for exposures and leases). */
  harnessSessionId: HarnessSessionId.optional(),
});
export type InternalMcpMeta = z.infer<typeof InternalMcpMeta>;

/** Request body with the input not yet validated (core validates per tool). */
export const InternalMcpRequest = z.object({
  input: z.unknown(),
  meta: InternalMcpMeta.optional(),
});
export type InternalMcpRequest = z.infer<typeof InternalMcpRequest>;

/** Request body schema for one tool. */
export function internalMcpRequestSchema<T extends ToolName>(tool: T) {
  return z.object({ input: TOOLS[tool].input as (typeof TOOLS)[T]['input'], meta: InternalMcpMeta.optional() });
}

/** Response schema for one tool: success with typed output, or an MCP-cased error body. */
export function internalMcpResponseSchema<T extends ToolName>(tool: T) {
  return z.union([
    z.object({ ok: z.literal(true), output: TOOLS[tool].output as (typeof TOOLS)[T]['output'] }),
    McpErrorBody,
  ]);
}

/** Success response. */
export type InternalMcpSuccess<T extends ToolName> = { ok: true; output: ToolOutput<T> };
/** Response for one tool. */
export type InternalMcpResponse<T extends ToolName> = InternalMcpSuccess<T> | McpErrorBody;
