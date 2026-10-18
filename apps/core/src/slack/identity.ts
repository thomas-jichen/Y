/** Slack identity lookups (service role) and the cached workspace install. */
import type { Queryable } from '@y/db';
import type { CoreDeps } from '../contracts.js';
import type { SlackClient } from './client.js';
import { INLINE_SLACK_TIMEOUT_MS } from './config.js';

/** The Y user an active Slack link points to, or null. */
export async function linkedUserFor(q: Queryable, slackTeamId: string, slackUserId: string): Promise<string | null> {
  const r = await q.query<{ user_id: string }>(
    `select user_id from public.slack_identity_links where slack_team_id = $1 and slack_user_id = $2 and revoked_at is null`,
    [slackTeamId, slackUserId]);
  return r.rows[0]?.user_id ?? null;
}

export interface ActiveLink { slackTeamId: string; slackUserId: string; teamName: string | null; linkedAt: Date }

/** A user's active Slack link (v1: one workspace). */
export async function activeLinkFor(q: Queryable, userId: string): Promise<ActiveLink | null> {
  const r = await q.query<{ slack_team_id: string; slack_user_id: string; slack_team_name: string | null; linked_at: Date | string }>(
    `select slack_team_id, slack_user_id, slack_team_name, linked_at from public.slack_identity_links
      where user_id = $1 and revoked_at is null order by linked_at desc limit 1`, [userId]);
  const row = r.rows[0];
  return row ? { slackTeamId: row.slack_team_id, slackUserId: row.slack_user_id, teamName: row.slack_team_name, linkedAt: new Date(row.linked_at) } : null;
}

export interface NotifyPrefs { slack: boolean; kinds: Record<string, unknown> }

export async function prefsFor(q: Queryable, userId: string): Promise<NotifyPrefs> {
  const r = await q.query<{ slack: boolean | null; kinds: Record<string, unknown> | null }>(
    `select (channels -> 'slack') = 'true'::jsonb as slack, kinds from public.notification_prefs where user_id = $1`, [userId]);
  return { slack: r.rows[0]?.slack === true, kinds: r.rows[0]?.kinds ?? {} };
}

export interface Installation { teamId: string; teamName: string | null; botUserId: string | null }

const installs = new WeakMap<SlackClient, Promise<Installation>>();

/**
 * auth.test once per client (per process), recorded in slack_installations.
 * Called on request paths (Slack's 3 s ack), so it uses the inline timeout;
 * a failure is not cached and the next request retries.
 */
export function ensureInstallation(deps: CoreDeps, client: SlackClient): Promise<Installation> {
  let p = installs.get(client);
  if (!p) {
    p = (async () => {
      const t = await client.authTest({ timeoutMs: INLINE_SLACK_TIMEOUT_MS });
      if (!/^[A-Z0-9]{5,20}$/.test(t.teamId)) throw new Error('slack auth.test returned no team');
      const botUserId = t.botUserId && /^[A-Z0-9]{5,20}$/.test(t.botUserId) ? t.botUserId : null;
      await deps.db.asService((tx) => tx.query(
        `insert into public.slack_installations (slack_team_id, team_name, bot_user_id, bot_token_secret_name)
         values ($1, $2, $3, 'SLACK_BOT_TOKEN')
         on conflict (slack_team_id) do update set team_name = excluded.team_name, bot_user_id = excluded.bot_user_id, revoked_at = null`,
        [t.teamId, t.teamName?.slice(0, 80) ?? null, botUserId]));
      return { teamId: t.teamId, teamName: t.teamName, botUserId };
    })();
    p.catch(() => installs.delete(client));
    installs.set(client, p);
  }
  return p;
}
