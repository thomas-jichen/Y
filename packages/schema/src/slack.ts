/**
 * Slack integration (PLAN §11), web API under `/api/v1/slack/*`.
 *
 * | Method + path | Request | Response |
 * |---|---|---|
 * | `GET /slack/status` | | {@link SlackStatus} |
 * | `POST /slack/link/preview` | {@link SlackLinkRequest} | {@link SlackLinkPreview} (read-only: the token is not spent) |
 * | `POST /slack/link` | {@link SlackLinkRequest} | {@link SlackStatus} (linked: true) |
 * | `POST /slack/unlink` (alias `DELETE /slack/link`) | `{}` | {@link SlackStatus} (linked: false) |
 *
 * Errors on `POST /slack/link`: 400 VALIDATION; 404 NOT_FOUND (the token is
 * invalid, used or expired); 403 SCOPE_FORBIDDEN (not a web session); 429
 * RATE_LIMITED; 401 STEP_UP_REQUIRED (linking grants approval power, I5).
 * The web shows the preview and sends `POST /slack/link` only on an explicit
 * click, never on page load, so a forwarded link cannot bind a viewer's Y
 * account to someone else's Slack user.
 *
 * @module slack
 */
import { z } from 'zod';
import { IsoTimestamp, singleLine } from './common.js';

export const SlackUserId = z.string().regex(/^[A-Z0-9]{5,20}$/);
export type SlackUserId = z.infer<typeof SlackUserId>;

/** `ysl_` + 32 random bytes, base64url. Single use, 10 minutes. */
export const SlackLinkToken = z.string().regex(/^ysl_[A-Za-z0-9_-]{43}$/);
export type SlackLinkToken = z.infer<typeof SlackLinkToken>;

/** `GET /api/v1/slack/status`, and the response of `POST /slack/link` and `POST /slack/unlink`. */
export const SlackStatus = z.object({
  /** Core has SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET. */
  available: z.boolean(),
  linked: z.boolean(),
  slackUserId: SlackUserId.optional(),
  workspaceName: singleLine(80).optional(),
  linkedAt: IsoTimestamp.optional(),
  /** notification_prefs.channels.slack */
  notifications: z.boolean(),
  /** Team feed channels for the caller's teams (`/y feed`). */
  feedChannels: z
    .array(z.object({ teamSlug: z.string().max(64), channelId: z.string().regex(/^[CG][A-Z0-9]{4,19}$/) }))
    .max(20),
});
export type SlackStatus = z.infer<typeof SlackStatus>;

export const SlackLinkRequest = z.object({ token: SlackLinkToken });
export type SlackLinkRequest = z.infer<typeof SlackLinkRequest>;

/** `POST /api/v1/slack/link/preview`: who the token would link, without spending it. */
export const SlackLinkPreview = z.object({
  slackUserId: SlackUserId,
  /** The Slack username at `/y connect` time, when Slack sent one. */
  slackUserName: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).optional(),
  workspaceName: singleLine(80).optional(),
  expiresAt: IsoTimestamp,
});
export type SlackLinkPreview = z.infer<typeof SlackLinkPreview>;
