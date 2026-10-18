/** Slack constants and the on/off gate (PLAN §11). */
import type { AuthClaims } from '@y/db';
import type { CoreConfig } from '../contracts.js';

/** Link tokens from `/y connect` live this long. */
export const LINK_TTL_MS = 10 * 60_000;
/** At most one room notice per user per room thread in this window. */
export const ROOM_NOTIFY_WINDOW_S = 600;
/** Max characters of a Slack reply accepted into Y. */
export const MAX_SLACK_BODY = 4000;
/** Max raw request body accepted on /slack/*. */
export const RAW_BODY_MAX = 64 * 1024;
/** Pending Slack instructions wait this long for the Confirm click. */
export const PENDING_TTL_MS = 15 * 60_000;
/** Timeout for Slack Web API calls made while Slack waits for our ack. */
export const INLINE_SLACK_TIMEOUT_MS = 1500;

export interface SlackConfig { botToken: string | null; signingSecret: string | null; teamId: string | null; webUrl: string }

export const DEFAULT_WEB_URL = 'https://y-web-beta.vercel.app';

/** True when both the bot token and the signing secret are configured. */
export function slackEnabled(cfg: CoreConfig): boolean {
  return !!(cfg.slack?.botToken && cfg.slack?.signingSecret);
}

export function webUrl(cfg: CoreConfig): string {
  return (cfg.slack?.webUrl ?? DEFAULT_WEB_URL).replace(/\/+$/, '');
}

/** RLS claims for a linked Slack user (a human context, via 'slack'). */
export function slackClaims(userId: string): AuthClaims {
  return { sub: userId, via: 'slack' };
}
