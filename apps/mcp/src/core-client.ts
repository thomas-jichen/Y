/**
 * Forwarding client for core's internal MCP API (`POST /internal/mcp/:tool`).
 *
 * `apps/mcp` holds no DB credentials (I7): every tool call becomes one signed
 * request to core carrying the caller's `Authorization` header unchanged.
 * The signature follows the `@y/schema/internal` contract:
 * `X-Y-Internal: t=<unix>,v1=<hex HMAC-SHA256(secret, internalSigningString(...))>`.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  ErrorBody,
  INTERNAL_HEADERS,
  McpErrorBody,
  fromMcpErrorBody,
  formatInternalSignatureHeader,
  internalMcpPath,
  internalSigningString,
  makeError,
  type InternalMcpMeta,
  type ToolName,
} from '@y/schema';

/** Runtime configuration for the forwarder. */
export interface CoreClientConfig {
  /** Base URL of core, e.g. `http://127.0.0.1:8787` (no trailing slash needed). */
  coreUrl: string;
  /** `Y_INTERNAL_SECRET`. */
  internalSecret: string;
  /** Y web origin for connect/reconnect guidance. */
  webUrl: string;
  /** Per-request timeout, ms. */
  timeoutMs?: number;
  /** Injected for tests; defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Injected clock (unix ms) for tests. */
  now?: () => number;
}

/** Per-call options. */
export interface CallOptions {
  /** The caller's `Authorization` header, forwarded verbatim (absent for signed-out callers). */
  authorization?: string | undefined;
  meta?: InternalMcpMeta | undefined;
  signal?: AbortSignal | undefined;
}

export type CoreResult = { ok: true; output: unknown } | ErrorBody;

const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');

/** Compute the `X-Y-Internal` header value for one request. */
export function signInternalRequest(args: {
  secret: string;
  method: string;
  path: string;
  body: string;
  authorization?: string | undefined;
  timestampS: number;
}): string {
  const signing = internalSigningString({
    timestamp: args.timestampS,
    method: args.method,
    path: args.path,
    bodySha256: sha256Hex(args.body),
    authSha256: args.authorization ? sha256Hex(args.authorization) : '-',
  });
  const hmac = createHmac('sha256', args.secret).update(signing, 'utf8').digest('hex');
  return formatInternalSignatureHeader(args.timestampS, hmac);
}

/** Read configuration from the environment. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CoreClientConfig {
  return {
    coreUrl: env.Y_CORE_URL ?? 'http://127.0.0.1:8787',
    internalSecret: env.Y_INTERNAL_SECRET ?? '',
    webUrl: env.Y_WEB_URL ?? 'http://localhost:5173',
    timeoutMs: env.Y_CORE_TIMEOUT_MS ? Number(env.Y_CORE_TIMEOUT_MS) : 20_000,
  };
}

/** Env vars the forwarder cannot work without. */
export const REQUIRED_CORE_ENV = ['Y_CORE_URL', 'Y_INTERNAL_SECRET'] as const;

/** Names of the required env vars that are unset or blank. */
export function missingCoreEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_CORE_ENV.filter((name) => !env[name]?.trim());
}

/**
 * Startup check for the served entry. Without these, every tool call would
 * surface to agents as "reconnect" or "core unreachable", which sends humans
 * debugging the wrong thing; fail loudly at boot instead.
 */
export function assertCoreEnv(env: NodeJS.ProcessEnv = process.env): void {
  const missing = missingCoreEnv(env);
  if (missing.length > 0) {
    throw new Error(
      `y mcp: ${missing.join(' and ')} must be set (Y_CORE_URL is core's base URL; Y_INTERNAL_SECRET must equal core's value). See docs/RUNNING.md.`,
    );
  }
}

/** Guidance error for tools that need sign-in when no token was sent. */
export function unauthorizedError(webUrl: string, message?: string): ErrorBody {
  return makeError(
    'UNAUTHORIZED',
    message ??
      'This tool needs a connected Y agent. Ask your human to connect this agent (install the Y plugin and run its connect step, or add a Y token to this MCP server), then retry.',
    { next: { humanAction: 'reconnect', url: new URL('/connect', webUrl).toString() } },
  );
}

/** Create the forwarder. */
export function createCoreClient(cfg: CoreClientConfig) {
  const doFetch = cfg.fetch ?? fetch;
  const now = cfg.now ?? Date.now;
  const timeoutMs = cfg.timeoutMs ?? 20_000;

  async function call(tool: ToolName, input: unknown, opts: CallOptions = {}): Promise<CoreResult> {
    const path = internalMcpPath(tool);
    // A fresh nonce per request: core refuses a replay of the same signed request.
    // wideSetupNames: this build parses compare_setups names as SetupSignalName,
    // so core may send `model:...[1m]` and long plugin@marketplace keys.
    const meta: InternalMcpMeta = { ...(opts.meta ?? {}), nonce: randomBytes(16).toString('hex'), wideSetupNames: true };
    const body = JSON.stringify({ input, meta });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      [INTERNAL_HEADERS.signature]: signInternalRequest({
        secret: cfg.internalSecret,
        method: 'POST',
        path,
        body,
        authorization: opts.authorization,
        timestampS: Math.floor(now() / 1000),
      }),
    };
    if (opts.authorization) headers[INTERNAL_HEADERS.authorization] = opts.authorization;
    if (opts.meta?.requestId) headers[INTERNAL_HEADERS.requestId] = opts.meta.requestId;

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await doFetch(new URL(path, cfg.coreUrl), { method: 'POST', headers, body, signal });
    } catch {
      return makeError('INTERNAL', 'Y core is unreachable right now. Retry shortly.', {
        retryable: true,
        retryAfterS: 5,
      });
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return makeError('INTERNAL', `Y core returned an unreadable response (HTTP ${res.status}).`, {
        retryable: res.status >= 500,
      });
    }

    if (json && typeof json === 'object' && (json as { ok?: unknown }).ok === true && 'output' in json) {
      return { ok: true, output: (json as { output: unknown }).output };
    }
    // Core's internal MCP API answers in MCP casing (retry_after_s, next.human_action); accept REST casing too.
    const mcp = McpErrorBody.safeParse(json);
    const parsed = mcp.success ? { success: true as const, data: fromMcpErrorBody(mcp.data) } : ErrorBody.safeParse(json);
    if (parsed.success) {
      const e = parsed.data.error;
      if (e.code === 'UNAUTHORIZED' && !e.next) return unauthorizedError(cfg.webUrl, e.message);
      return parsed.data;
    }
    if (res.status === 401) return unauthorizedError(cfg.webUrl);
    return makeError('INTERNAL', `Y core returned an unexpected response (HTTP ${res.status}).`, {
      retryable: res.status >= 500,
    });
  }

  return { call, config: cfg };
}

export type CoreClient = ReturnType<typeof createCoreClient>;
