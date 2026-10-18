/**
 * BUILDERS module (PLAN §5 "Builder discovery", §6 "Customer → builder",
 * milestone M7): products + verified claims, find_builder / ask_builder,
 * support-thread routing (messaging/support.ts) and the builder approval
 * queue.
 *
 * Routes: GET/POST /api/v1/products, PATCH /api/v1/products/:id,
 * POST /api/v1/products/:id/claims, POST /api/v1/products/:id/claims/verify,
 * GET /api/v1/builders/claims (public).
 * Jobs: review.builder_reply (apply the builder's human decision).
 * Agent tools (find_builder, ask_builder) are exported for internal-mcp.
 */
import type { CoreModule, JobHandler } from '../contracts.js';
import { applyBuilderReplyDecision } from '../messaging/support.js';
import { HttpError } from '../messaging/util.js';
import { registerProductRoutes } from './products.js';

export { findBuilder, askBuilder, composeQuestion, errorTokens } from './tools.js';
export { verifyClaimMarker, markerUrl, guardedFetch, type FetchLike } from './verify.js';
export { applyBuilderReplyDecision } from '../messaging/support.js';

/** Worker side of a human decision on a builder_reply review item (enqueued by the platform decision route). */
const builderReplyDecision: JobHandler = async (payload, deps) => {
  const ref = typeof payload.refId === 'string' ? payload.refId : null;
  const d = payload.decision;
  if (!ref || (d !== 'approve' && d !== 'reject')) return;
  const edits = payload.edits && typeof payload.edits === 'object' ? (payload.edits as { body?: unknown }) : {};
  try {
    await applyBuilderReplyDecision(deps, ref, d, typeof edits.body === 'string' ? { body: edits.body } : {});
  } catch (e) {
    // Already decided (or the draft is gone): nothing to retry.
    if (e instanceof HttpError && (e.code === 'CONFLICT' || e.code === 'NOT_FOUND')) {
      deps.log('warn', 'review.builder_reply: nothing to apply', { code: e.code });
      return;
    }
    throw e;
  }
};

export const buildersModule: CoreModule = {
  register(app, deps) {
    registerProductRoutes(app, deps);
  },
  jobs: {
    'review.builder_reply': builderReplyDecision,
  },
};
