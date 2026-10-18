/**
 * INTERNAL MCP API: POST /internal/mcp/:tool (apps/mcp → core).
 * 1. HMAC (X-Y-Internal) via deps.auth.verifyInternal; bad → 401.
 * 2. Authorization → Caller via deps.auth.verifyBearer; a present-but-invalid
 *    token → 401; absent → 401 unless TOOL_POLICY[tool].auth is 'optional'.
 * 3. Validate input with TOOLS[tool].input, run the handler, validate the
 *    output with TOOLS[tool].output; respond {ok:true, output} or ErrorBody.
 * Bodies are capped at INTERNAL_BODY_MAX and a missing or malformed
 * signature header is refused before the body is read; a signed request
 * with `meta.nonce` is accepted once (ReplayCache); every tool takes its
 * TOOL_POLICY bucket (limits.ts).
 */
import { TOOLS, TOOL_POLICY, ToolName, makeError, parseInternalSignatureHeader, toMcpErrorBody, validationError, type ErrorBody } from '@y/schema';
import { bodyLimit } from 'hono/body-limit';
import type { ZodType } from 'zod';
import type { CoreModule } from '../contracts.js';
import { HttpError } from '../messaging/util.js';
import { HANDLERS } from './tools.js';
import { SCROLL_BUCKET, SEND_BUCKET, takeToken } from '../platform/rate-limit.js';
import { INTERNAL_BODY_MAX, ReplayCache, nonceOf, takeToolBucket } from './limits.js';

export { HANDLERS, CUT_TOOLS, EMBEDDING_DIMS } from './tools.js';

/** Tool-level errors are HTTP 200 + McpErrorBody (snake_case); 401 only for HMAC / caller token failures. */
const mcpErr = (body: ErrorBody) => toMcpErrorBody(body);

export const internalMcpModule: CoreModule = {
  register(app, deps) {
    const replays = new ReplayCache();
    app.post('/internal/mcp/:tool', bodyLimit({
      maxSize: INTERNAL_BODY_MAX,
      onError: (c) => c.json(mcpErr(makeError('VALIDATION', 'request body too large')), 413),
    }), async (c) => {
      try {
        // Cheap header check first: unsigned callers never get the body hashed.
        const sig = c.req.header('x-y-internal');
        if (!sig || !parseInternalSignatureHeader(sig)) return c.json(mcpErr(makeError('UNAUTHORIZED', 'bad internal signature')), 401);
        const raw = await c.req.text();
        const ok = deps.auth.verifyInternal({ method: c.req.method, path: c.req.path, body: raw, header: (n) => c.req.header(n) });
        if (!ok) return c.json(mcpErr(makeError('UNAUTHORIZED', 'bad internal signature')), 401);

        const tool = ToolName.safeParse(c.req.param('tool'));
        if (!tool.success) return c.json(mcpErr(makeError('NOT_FOUND', 'unknown tool')), 404);
        const name = tool.data;

        const authz = c.req.header('authorization');
        const caller = authz ? await deps.auth.verifyBearer(authz) : null;
        if (authz && !caller) return c.json(mcpErr(makeError('UNAUTHORIZED', 'invalid credentials', { next: { humanAction: 'reconnect', url: `${deps.config.publicUrl}/connect` } })), 401);
        if (!caller && TOOL_POLICY[name].auth === 'required') return c.json(mcpErr(makeError('UNAUTHORIZED', 'sign in to use this tool')), 401);

        let body: unknown;
        try { body = raw ? JSON.parse(raw) : {}; } catch { return c.json(mcpErr(makeError('VALIDATION', 'body must be JSON'))); }
        const meta = (body as { meta?: unknown } | null)?.meta;
        const nonce = nonceOf(meta);
        if (nonce && !replays.firstUse(`${sig}\n${nonce}`, deps.now().getTime())) {
          return c.json(mcpErr(makeError('UNAUTHORIZED', 'replayed internal request')), 401);
        }
        const input = (TOOLS[name].input as ZodType).safeParse((body as { input?: unknown } | null)?.input ?? {});
        if (!input.success) return c.json(mcpErr(validationError(input.error)));

        await takeToolBucket(deps, name, caller, meta);

        // ask_builder shares send_message's bucket (TOOL_POLICY rateLimit 'send_message').
        if ((name === 'send_message' || name === 'ask_builder') && caller?.agentId) {
          const agentId = caller.agentId;
          const rl = await deps.db.asUser(caller.claims, (tx) => takeToken(tx, 'send', [agentId], SEND_BUCKET));
          if (!rl.allowed) throw new HttpError('RATE_LIMITED', `${name} is limited to 30 per hour (shared with send_message)`, { retryAfterS: rl.retryAfterS });
        }
        if (name === 'scroll_feed' && caller?.agentId) {
          const agentId = caller.agentId;
          const rl = await deps.db.asUser(caller.claims, (tx) => takeToken(tx, 'scroll_feed', [agentId], SCROLL_BUCKET));
          if (!rl.allowed) throw new HttpError('RATE_LIMITED', 'scroll_feed is limited to 20 per hour', { retryAfterS: rl.retryAfterS });
        }
        const handler = HANDLERS[name] as (d: typeof deps, cl: typeof caller, i: unknown) => Promise<unknown>;
        const output = await handler(deps, caller, input.data);
        const checked = (TOOLS[name].output as ZodType).safeParse(output);
        if (!checked.success) {
          deps.log('error', 'tool output failed its contract', { tool: name, issues: JSON.stringify(checked.error.issues).slice(0, 2000) });
          throw new HttpError('INTERNAL', 'tool output failed validation');
        }
        return c.json({ ok: true, output: checked.data });
      } catch (err) {
        if (err instanceof HttpError) return c.json(mcpErr(err.body));
        deps.log('error', 'internal mcp tool failed', { err: String(err), path: c.req.path });
        return c.json(mcpErr(makeError('INTERNAL', 'internal error')));
      }
    });
  },
  jobs: {},
};
