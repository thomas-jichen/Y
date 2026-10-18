/**
 * Forwarding client for core's internal MCP API (`POST /internal/mcp/:tool`).
 *
 * `apps/mcp` holds no DB credentials (I7): every tool call becomes one signed
 * request to core carrying the caller's `Authorization` header unchanged.
 * The signature follows the `@paceline/schema/internal` contract:
 * `X-Paceline-Internal: t=<unix>,v1=<hex HMAC-SHA256(secret, internalSigningString(...))>`.
 */
import { createHash, createHmac } from 'node:crypto';
import {
  ErrorBody,
  INTERNAL_HEADERS,
  formatInternalSignatureHeader,
  internalMcpPath,
  internalSigningString,
  makeError,
  type InternalMcpMeta,
  type ToolName,
} from '@paceline/schema';

/** Runtime configuration for the forwarder. */
export interface CoreClientConfig {
  /** Base URL of core, e.g. `http://127.0.0.1:8787` (no trailing slash needed). */
  coreUrl: string;
  /** `PACELINE_INTERNAL_SECRET`. */
  internalSecret: string;
  /** Paceline web origin for connect/reconnect guidance. */
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

/** Compute the `X-Paceline-Internal` header value for one request. */
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
    coreUrl: env.PACELINE_CORE_URL ?? 'http://127.0.0.1:8787',
    internalSecret: env.PACELINE_INTERNAL_SECRET ?? '',
    webUrl: env.PACELINE_WEB_URL ?? 'http://localhost:5173',
    timeoutMs: env.PACELINE_CORE_TIMEOUT_MS ? Number(env.PACELINE_CORE_TIMEOUT_MS) : 20_000,
  };
}

/** Guidance error for tools that need sign-in when no token was sent. */
export function unauthorizedError(webUrl: string, message?: string): ErrorBody {
  return makeError(
    'UNAUTHORIZED',
    message ??
      'This tool needs a connected Paceline agent. Ask your human to connect this agent (install the Paceline plugin and run its connect step, or add a Paceline token to this MCP server), then retry.',
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
    const body = JSON.stringify(opts.meta ? { input, meta: opts.meta } : { input });
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
      return makeError('INTERNAL', 'Paceline core is unreachable right now. Retry shortly.', {
        retryable: true,
        retryAfterS: 5,
      });
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return makeError('INTERNAL', `Paceline core returned an unreadable response (HTTP ${res.status}).`, {
        retryable: res.status >= 500,
      });
    }

    if (json && typeof json === 'object' && (json as { ok?: unknown }).ok === true && 'output' in json) {
      return { ok: true, output: (json as { output: unknown }).output };
    }
    const parsed = ErrorBody.safeParse(json);
    if (parsed.success) {
      const e = parsed.data.error;
      if (e.code === 'UNAUTHORIZED' && !e.next) return unauthorizedError(cfg.webUrl, e.message);
      return parsed.data;
    }
    if (res.status === 401) return unauthorizedError(cfg.webUrl);
    return makeError('INTERNAL', `Paceline core returned an unexpected response (HTTP ${res.status}).`, {
      retryable: res.status >= 500,
    });
  }

  return { call, config: cfg };
}

export type CoreClient = ReturnType<typeof createCoreClient>;
