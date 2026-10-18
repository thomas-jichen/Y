/**
 * INTERNAL MCP API: POST /internal/mcp/:tool (apps/mcp → core).
 * 1. HMAC (X-Paceline-Internal) via deps.auth.verifyInternal; bad → 401.
 * 2. Authorization → Caller via deps.auth.verifyBearer; a present-but-invalid
 *    token → 401; absent → 401 unless TOOL_POLICY[tool].auth is 'optional'.
 * 3. Validate input with TOOLS[tool].input, run the handler, validate the
 *    output with TOOLS[tool].output; respond {ok:true, output} or ErrorBody.
 */
import { TOOLS, TOOL_POLICY, ToolName, makeError, toMcpErrorBody, validationError, type ErrorBody } from '@paceline/schema';
import type { ZodType } from 'zod';
import type { CoreModule } from '../contracts.js';
import { HttpError } from '../messaging/util.js';
import { HANDLERS } from './tools.js';
import { SEND_BUCKET, takeToken } from '../platform/rate-limit.js';

export { HANDLERS, CUT_TOOLS, EMBEDDING_DIMS } from './tools.js';

/** Tool-level errors are HTTP 200 + McpErrorBody (snake_case); 401 only for HMAC / caller token failures. */
const mcpErr = (body: ErrorBody) => toMcpErrorBody(body);

export const internalMcpModule: CoreModule = {
  register(app, deps) {
    app.post('/internal/mcp/:tool', async (c) => {
      try {
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
        const input = (TOOLS[name].input as ZodType).safeParse((body as { input?: unknown } | null)?.input ?? {});
        if (!input.success) return c.json(mcpErr(validationError(input.error)));

        if (name === 'send_message' && caller?.agentId) {
          const agentId = caller.agentId;
          const rl = await deps.db.asUser(caller.claims, (tx) => takeToken(tx, 'send', [agentId], SEND_BUCKET));
          if (!rl.allowed) throw new HttpError('RATE_LIMITED', 'send_message is limited to 30 per hour', { retryAfterS: rl.retryAfterS });
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
