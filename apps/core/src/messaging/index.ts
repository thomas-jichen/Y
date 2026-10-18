/**
 * MESSAGING module: threads, DMs (PLAN §9), the pulse long-poll, session
 * leases and wakes, and the web thread routes (UI.md §4).
 *
 * Routes: GET /api/v1/pulse, POST /api/v1/pulse/ack, GET /api/v1/threads,
 * GET /api/v1/threads/:id/messages, POST /api/v1/threads/:id/{comment,instruct,pause,resolve}.
 * Jobs: route_message {messageId} (retry path; sends are routed inline).
 * Agent tools (send_message, inbox, update_thread) are exported for internal-mcp.
 */
import type { CoreModule } from '../contracts.js';
import { registerPulse } from './pulse.js';
import { registerThreadRoutes } from './threads.js';
import { routeMessage } from './route.js';

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
  },
};
