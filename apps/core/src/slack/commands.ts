/** `/y` slash commands (spec §3.3). Every reply is ephemeral; work is inline and small. */
import { randomBytes } from 'node:crypto';
import type { CoreDeps } from '../contracts.js';
import { takeToken } from '../platform/rate-limit.js';
import { sha256Hex } from '../platform/util.js';
import { userInfos } from '../messaging/util.js';
import type { SlackClient } from './client.js';
import { LINK_TTL_MS, webUrl } from './config.js';
import { ensureInstallation, linkedUserFor, prefsFor } from './identity.js';
import type { SlashCommand } from './payloads.js';
import * as R from './render.js';

export interface CommandReply { response_type: 'ephemeral'; text: string; blocks?: unknown[] }

function reply(m: R.SlackMessage): CommandReply {
  return { response_type: 'ephemeral', text: m.text, blocks: m.blocks };
}
function say(text: string): CommandReply {
  return reply(R.simple(text));
}

export async function handleCommand(deps: CoreDeps, client: SlackClient, cmd: SlashCommand): Promise<CommandReply> {
  const words = cmd.text.trim().split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
  const sub = words[0] ?? 'help';
  const limited = await deps.db.asService((tx) => takeToken(tx, 'slack:cmd', [cmd.team_id, cmd.user_id], { rate: 20 / 600, burst: 20 }));
  if (!limited.allowed) return say('Slow down a little.');

  switch (sub) {
    case 'connect': return connect(deps, client, cmd);
    case 'disconnect': return disconnect(deps, cmd);
    case 'status': return status(deps, cmd);
    case 'feed': return feed(deps, cmd, words.slice(1));
    default: return reply(R.h1());
  }
}

async function connect(deps: CoreDeps, client: SlackClient, cmd: SlashCommand): Promise<CommandReply> {
  await ensureInstallation(deps, client);
  const token = 'ysl_' + randomBytes(32).toString('base64url');
  // DB clock: api.complete_slack_link checks expires_at against now().
  // Shown on the web preview so the person linking sees whose Slack account it is.
  const name = /^[A-Za-z0-9._-]{1,80}$/.test(cmd.user_name ?? '') ? cmd.user_name! : null;
  await deps.db.asService((tx) => tx.query(
    `insert into public.slack_link_tokens (token_hash, slack_team_id, slack_user_id, expires_at, slack_user_name)
     values ($1, $2, $3, now() + $4::int * interval '1 millisecond', $5)`,
    [sha256Hex(token), cmd.team_id, cmd.user_id, LINK_TTL_MS, name]));
  // The token appears only in this ephemeral reply; it is never logged.
  return reply(R.c1(R.links.link(webUrl(deps.config), token)));
}

async function disconnect(deps: CoreDeps, cmd: SlashCommand): Promise<CommandReply> {
  const n = await deps.db.asService(async (tx) => {
    const r = await tx.query<{ user_id: string }>(
      `update public.slack_identity_links set revoked_at = now()
        where slack_team_id = $1 and slack_user_id = $2 and revoked_at is null returning user_id`, [cmd.team_id, cmd.user_id]);
    for (const row of r.rows) {
      await tx.query(`update public.notification_prefs set channels = channels || '{"slack": false}'::jsonb where user_id = $1`, [row.user_id]);
    }
    return r.rowCount;
  });
  return n > 0
    ? say('Disconnected. This Slack account is no longer linked to Y, and Y notifications here are off.')
    : say("This Slack account isn't linked.");
}

async function status(deps: CoreDeps, cmd: SlashCommand): Promise<CommandReply> {
  const s = await deps.db.asService(async (tx) => {
    const uid = await linkedUserFor(tx, cmd.team_id, cmd.user_id);
    if (!uid) return null;
    const handle = (await userInfos(tx, [uid])).get(uid)?.handle ?? 'unknown';
    const prefs = await prefsFor(tx, uid);
    const feeds = (await tx.query<{ slug: string; channel_id: string }>(
      `select t.slug::text as slug, c.channel_id from public.team_members m join public.teams t on t.id = m.team_id
         join public.team_slack_channels c on c.team_id = t.id where m.user_id = $1 order by t.slug limit 20`, [uid])).rows;
    return { handle, on: prefs.slack, feeds };
  });
  if (!s) return reply(R.c2());
  const lines = [
    `Linked to *${R.at(s.handle)}*.`,
    `Notifications in Slack: ${s.on ? 'on' : 'off'}.`,
    s.feeds.length ? `Team feeds: ${s.feeds.map((f) => `${R.safe(f.slug, 64)} → <#${f.channel_id}>`).join(', ')}` : 'No team feed channels.',
  ];
  return say(lines.join('\n'));
}

async function feed(deps: CoreDeps, cmd: SlashCommand, args: string[]): Promise<CommandReply> {
  const off = args[0] === 'off';
  const slug = (off ? args[1] : args[0]) ?? null;
  if (!/^[CG]/.test(cmd.channel_id)) return say('Run this in a channel.');
  return deps.db.asService(async (tx) => {
    const uid = await linkedUserFor(tx, cmd.team_id, cmd.user_id);
    if (!uid) return reply(R.c2());
    const teams = (await tx.query<{ id: string; slug: string; role: string; admins: number }>(
      `select t.id, t.slug::text as slug, m.role,
              (select count(*)::int from public.team_members x where x.team_id = t.id and x.role in ('owner', 'admin')) as admins
         from public.team_members m join public.teams t on t.id = m.team_id where m.user_id = $1 order by t.slug`, [uid])).rows;
    if (teams.length === 0) return say("You're not in a Y team yet.");
    let team = slug ? teams.find((t) => t.slug.toLowerCase() === slug) : teams.length === 1 ? teams[0] : undefined;
    if (!team) {
      return say(slug ? `You're not in a team called ${R.safe(slug, 64)}.` : `Pick a team: ${teams.map((t) => `\`/y feed ${off ? 'off ' : ''}${R.safe(t.slug, 64)}\``).join(', ')}`);
    }
    // Owners and admins only, or anyone when the team has none (the default team).
    if (!(team.role === 'owner' || team.role === 'admin' || team.admins === 0)) return say('Only a team owner or admin can set the feed channel.');
    if (off) {
      const r = await tx.query(`delete from public.team_slack_channels where team_id = $1 and channel_id = $2`, [team.id, cmd.channel_id]);
      return say(r.rowCount > 0 ? `Feed for *${R.safe(team.slug, 64)}* is off in this channel.` : 'This channel is not the feed for that team.');
    }
    await tx.query(
      `insert into public.team_slack_channels (team_id, slack_team_id, channel_id, set_by) values ($1, $2, $3, $4)
       on conflict (team_id) do update set slack_team_id = excluded.slack_team_id, channel_id = excluded.channel_id,
         set_by = excluded.set_by, updated_at = now()`,
      [team.id, cmd.team_id, cmd.channel_id, uid]);
    return reply(R.f1(team.slug, cmd.channel_id.startsWith('G')));
  });
}
