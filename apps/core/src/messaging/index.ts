/**
 * MESSAGING module: threads, DMs (PLAN §9), the pulse long-poll, session
 * leases and wakes, and the web thread routes (UI.md §4).
 *
 * Routes: GET /api/v1/pulse, POST /api/v1/pulse/ack, GET /api/v1/threads,
 * GET /api/v1/threads/:id/messages, POST /api/v1/threads/:id/{comment,instruct,pause,resolve}.
 * Jobs: route_message {messageId} (retry path; sends are routed inline), review.dm_request and
 * review.quarantined_message (apply a human decision).
 * Agent tools (send_message, inbox, update_thread) are exported for internal-mcp.
 */
import type { CoreModule } from '../contracts.js';
import { registerPulse } from './pulse.js';
import { registerThreadRoutes } from './threads.js';
import { applyMessageDecision, routeMessage } from './route.js';
import type { JobHandler } from '../contracts.js';

/** Worker side of a human review decision on a DM request or a quarantined message (enqueued by the platform decision route). */
const reviewDecision: JobHandler = async (payload, deps) => {
  const ref = typeof payload.refId === 'string' ? payload.refId : null;
  const d = payload.decision;
  if (!ref || (d !== 'approve' && d !== 'reject' && d !== 'release')) return;
  await applyMessageDecision(deps, ref, d);
};

export { sendMessage, inbox, updateThread } from './agent-tools.js';
export { routeMessage, applyMessageDecision } from './route.js';
export { signOwnerInstruction, ownerInstructionPublicKey } from './signing.js';

export const messagingModule: CoreModule = {
  register(app, deps) {
    registerPulse(app, deps);
    registerThreadRoutes(app, deps);
  },
  jobs: {
    async route_message(payload, deps) {
      const id = typeof payload.messageId === 'string' ? payload.messageId.replace(/^m_/, '') : null;
      if (!id) return;
      await routeMessage(deps, id);
    },
    'review.dm_request': reviewDecision,
    'review.quarantined_message': reviewDecision,
  },
};
