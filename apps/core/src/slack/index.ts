/**
 * SLACK module (docs/PLAN.md §11; v1: one internal workspace).
 *
 * Routes: POST /slack/events, POST /slack/commands, POST /slack/interactivity
 * (signed by Slack), GET /api/v1/slack/status, POST /api/v1/slack/link,
 * POST /api/v1/slack/unlink (+ DELETE /api/v1/slack/link).
 * Jobs: slack.notify_message, slack.notify_review, slack.review_decided,
 * slack.feed_activity, slack.welcome, slack.update_message, slack.event.
 *
 * Inert (url_verification only; jobs complete as no-ops) until both
 * SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET are set. No Slack SDK: signatures
 * are verified here and the Web API is called with fetch through an
 * injectable client.
 */
import type { CoreDeps, CoreModule } from '../contracts.js';
import { createFetchSlackClient, type SlackClient } from './client.js';
import { slackEnabled } from './config.js';
import { notifyJobs } from './notify.js';
import { replyJobs } from './replies.js';
import { registerSlackRoutes } from './routes.js';
import type { SlackCtx } from './shared.js';
import { registerSlackWebRoutes } from './web-routes.js';

export { slackEnabled, slackClaims } from './config.js';
export { verifySlackRequest } from './verify.js';
export { createFetchSlackClient, SlackApiError, PERMANENT_SLACK_ERRORS, type SlackClient } from './client.js';
export { enqueueMessageNotices, enqueueFeedCard } from './enqueue.js';

export function createSlackModule(opts: { client?: SlackClient | null } = {}): CoreModule {
  let fetched: { token: string; client: SlackClient } | null = null;
  const ctx: SlackCtx = {
    client(deps: CoreDeps) {
      if (!slackEnabled(deps.config)) return null;
      if (opts.client) return opts.client;
      if (opts.client === null) return null;
      const token = deps.config.slack!.botToken!;
      if (!fetched || fetched.token !== token) fetched = { token, client: createFetchSlackClient(token) };
      return fetched.client;
    },
  };
  return {
    register(app, deps) {
      registerSlackRoutes(app, deps, ctx);
      registerSlackWebRoutes(app, deps);
    },
    jobs: { ...notifyJobs(ctx), ...replyJobs(ctx) },
  };
}

export const slackModule: CoreModule = createSlackModule();
