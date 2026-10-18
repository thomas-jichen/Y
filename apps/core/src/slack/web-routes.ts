/**
 * Web API for Slack linking (packages/schema slack.ts): status, link, unlink.
 * Human web sessions only. Linking runs under the caller's RLS through the
 * definer api.complete_slack_link (via must be 'web'); unlinking through
 * api.unlink_slack().
 */
import type { Context, Hono } from 'hono';
import type { AuthClaims, Tx } from '@y/db';
import { isSqlState } from '@y/db';
import { SlackLinkPreview, SlackLinkRequest, SlackStatus } from '@y/schema';
import type { Caller, CoreDeps } from '../contracts.js';
import { authenticate } from '../platform/http.js';
import { requireRecentLogin } from '../platform/web-guard.js';
import { takeToken } from '../platform/rate-limit.js';
import { fail, parseOr, readJson, sha256Hex } from '../platform/util.js';
import { slackEnabled } from './config.js';

async function statusTx(tx: Tx, deps: CoreDeps, userId: string): Promise<SlackStatus> {
  const link = (await tx.query<{ slack_user_id: string; slack_team_name: string | null; linked_at: Date | string }>(
    `select slack_user_id, slack_team_name, linked_at from public.slack_identity_links
      where user_id = $1 and revoked_at is null order by linked_at desc limit 1`, [userId])).rows[0];
  const prefs = (await tx.query<{ slack: boolean }>(
    `select (channels -> 'slack') = 'true'::jsonb as slack from public.notification_prefs where user_id = $1`, [userId])).rows[0];
  const out: SlackStatus = { available: slackEnabled(deps.config), linked: !!link, notifications: !!link && prefs?.slack === true, feedChannels: [] };
  if (link) {
    out.slackUserId = link.slack_user_id;
    if (link.slack_team_name) out.workspaceName = link.slack_team_name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80);
    out.linkedAt = new Date(link.linked_at).toISOString();
  }
  return out;
}

/** Feed channels of the caller's teams (team_slack_channels is service-only). */
async function feedChannels(deps: CoreDeps, userId: string): Promise<SlackStatus['feedChannels']> {
  try {
    return await deps.db.asService(async (tx) =>
      (await tx.query<{ slug: string; channel_id: string }>(
        `select t.slug::text as slug, c.channel_id from public.team_members m join public.teams t on t.id = m.team_id
           join public.team_slack_channels c on c.team_id = t.id where m.user_id = $1 order by t.slug limit 20`, [userId])).rows
        .map((r) => ({ teamSlug: r.slug.slice(0, 64), channelId: r.channel_id })));
  } catch (e) {
    if (isSqlState(e, '42P01')) return []; // 9005 not applied yet
    throw e;
  }
}

async function status(deps: CoreDeps, caller: Caller, claims: AuthClaims = caller.claims): Promise<SlackStatus> {
  const s = await deps.db.asUser(claims, (tx) => statusTx(tx, deps, caller.userId));
  s.feedChannels = await feedChannels(deps, caller.userId);
  return SlackStatus.parse(s);
}

export function registerSlackWebRoutes(app: Hono, deps: CoreDeps): void {
  app.get('/api/v1/slack/status', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    return c.json(await status(deps, caller));
  });

  // Read-only: who the token would link (the web shows it and asks for a click before POST /slack/link).
  app.post('/api/v1/slack/link/preview', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const body = parseOr(c, SlackLinkRequest, await readJson(c));
    if (!body.ok) return body.res;
    const rl = await deps.db.asService((tx) => takeToken(tx, 'slack:linkpv', [caller.userId], { rate: 30 / 600, burst: 30 }));
    if (!rl.allowed) return fail(c, 'RATE_LIMITED', 'Too many link attempts. Try again in a few minutes.', { retryAfterS: rl.retryAfterS });
    const row = await deps.db.asService(async (tx) => (await tx.query<{
      slack_user_id: string; slack_user_name: string | null; team_name: string | null; expires_at: Date | string;
    }>(
      `select t.slack_user_id, t.slack_user_name, i.team_name, t.expires_at from public.slack_link_tokens t
         left join public.slack_installations i on i.slack_team_id = t.slack_team_id
        where t.token_hash = $1 and t.used_at is null and t.expires_at > now()`, [sha256Hex(body.data.token)])).rows[0]);
    if (!row) return fail(c, 'NOT_FOUND', 'This link is invalid, used or expired. Run /y connect in Slack again.');
    const out: SlackLinkPreview = { slackUserId: row.slack_user_id, expiresAt: new Date(row.expires_at).toISOString() };
    if (row.slack_user_name) out.slackUserName = row.slack_user_name;
    if (row.team_name) out.workspaceName = row.team_name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80);
    return c.json(SlackLinkPreview.parse(out));
  });

  app.post('/api/v1/slack/link', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    // A /dev/demo session ends with the demo (#44); a Slack link would not, and it lets that
    // Slack user approve, release and instruct for the real account. Not from the demo account.
    if (caller.demoAccount) return fail(c, 'SCOPE_FORBIDDEN', 'The demo account cannot link Slack. Sign in with GitHub to link your own account.');
    // A link lets that Slack user approve, release and instruct for this account (I5): recent login only.
    const stepUp = await requireRecentLogin(c, deps);
    if (stepUp) return stepUp;
    const body = parseOr(c, SlackLinkRequest, await readJson(c));
    if (!body.ok) return body.res;
    const rl = await deps.db.asService((tx) => takeToken(tx, 'slack:link', [caller.userId], { rate: 10 / 600, burst: 10 }));
    if (!rl.allowed) return fail(c, 'RATE_LIMITED', 'Too many link attempts. Try again in a few minutes.', { retryAfterS: rl.retryAfterS });
    try {
      await deps.db.asUser(caller.claims, async (tx) => {
        await tx.query('select * from api.complete_slack_link($1)', [sha256Hex(body.data.token)]);
        await tx.query(
          `insert into public.notification_prefs (user_id, channels) values ($1, '{"web": true, "slack": true}'::jsonb)
           on conflict (user_id) do update set channels = notification_prefs.channels || '{"slack": true}'::jsonb`, [caller.userId]);
        const l = (await tx.query<{ linked_at: Date | string }>(
          `select linked_at from public.slack_identity_links where user_id = $1 and revoked_at is null order by linked_at desc limit 1`,
          [caller.userId])).rows[0];
        const epoch = l ? new Date(l.linked_at).getTime() : deps.now().getTime();
        // Best-effort welcome DM (a no-op job when Slack is inert).
        await deps.jobs.enqueue('slack.welcome', { userId: caller.userId }, { dedupeKey: `slack:welcome:${caller.userId}:${epoch}`, tx });
      });
    } catch (e) {
      if (isSqlState(e, 'P0002')) return fail(c, 'NOT_FOUND', 'This link is invalid, used or expired. Run /y connect in Slack again.');
      if (isSqlState(e, '42501')) return fail(c, 'SCOPE_FORBIDDEN', 'Linking Slack needs a signed-in web session.');
      throw e;
    }
    return c.json(await status(deps, caller));
  });

  const unlink = async (c: Context) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    try {
      await deps.db.asUser(caller.claims, (tx) => tx.query('select api.unlink_slack()'));
    } catch (e) {
      if (isSqlState(e, '42501')) return fail(c, 'SCOPE_FORBIDDEN', 'Unlinking Slack needs a signed-in web session.');
      throw e;
    }
    return c.json(await status(deps, caller));
  };
  app.post('/api/v1/slack/unlink', unlink);
  app.delete('/api/v1/slack/link', unlink);
}
