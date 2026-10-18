/** Shared plumbing for Slack handlers: the client getter and the job error policy. */
import type { CoreDeps, JobHandler } from '../contracts.js';
import { isPermanentSlackError, type SlackClient } from './client.js';
import { slackEnabled } from './config.js';

export interface SlackCtx {
  /** The Slack client, or null when Slack is inert. */
  client(deps: CoreDeps): SlackClient | null;
}

/**
 * Wrap a job: inert Slack completes as a no-op; a permanent Slack error is
 * logged (method + code only) and completes; anything else is rethrown so
 * fail_job backs off and retries.
 */
export function slackJob(ctx: SlackCtx, fn: (payload: Record<string, unknown>, deps: CoreDeps, client: SlackClient) => Promise<void>): JobHandler {
  return async (payload, deps) => {
    const client = slackEnabled(deps.config) ? ctx.client(deps) : null;
    if (!client) return;
    try {
      await fn(payload, deps, client);
    } catch (e) {
      if (isPermanentSlackError(e)) {
        deps.log('warn', 'slack call failed permanently', { method: e.method, code: e.code });
        return;
      }
      throw e;
    }
  };
}
