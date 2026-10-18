/**
 * Slack-facing endpoints (not under /api: no CORS or Origin guard). Each
 * reads the raw body once, verifies the v0 signature over it, checks the
 * workspace, and acks within Slack's 3 s: heavy work goes to jobs.
 */
import type { Context, Hono } from 'hono';
import type { CoreDeps } from '../contracts.js';
import { makeError } from '@y/schema';
import { handleBlockActions } from './actions.js';
import type { SlackClient } from './client.js';
import { handleCommand } from './commands.js';
import { MAX_SLACK_BODY, RAW_BODY_MAX, slackEnabled } from './config.js';
import { ensureInstallation } from './identity.js';
import { BlockActions, EventCallback, SlashCommand } from './payloads.js';
import type { SlackCtx } from './shared.js';
import { verifySlackRequest } from './verify.js';

type Raw = { raw: string } | { res: Response };

async function readRaw(c: Context): Promise<Raw> {
  const len = Number(c.req.header('content-length') ?? '0');
  if (len > RAW_BODY_MAX) return { res: c.json(makeError('VALIDATION', 'payload too large'), 413) };
  const raw = await c.req.text();
  if (raw.length > RAW_BODY_MAX) return { res: c.json(makeError('VALIDATION', 'payload too large'), 413) };
  return { raw };
}

function verified(c: Context, deps: CoreDeps, raw: string): boolean {
  return verifySlackRequest({
    signingSecret: deps.config.slack?.signingSecret ?? '',
    timestamp: c.req.header('x-slack-request-timestamp'),
    signature: c.req.header('x-slack-signature'),
    rawBody: raw,
    nowS: Math.floor(deps.now().getTime() / 1000),
  });
}

function unauthorized(c: Context) {
  return c.json(makeError('UNAUTHORIZED', 'invalid Slack signature'), 401);
}

function challengeOf(raw: string): string | null {
  try {
    const b = JSON.parse(raw) as { type?: unknown; challenge?: unknown };
    return b?.type === 'url_verification' && typeof b.challenge === 'string' && b.challenge.length <= 200 ? b.challenge : null;
  } catch {
    return null;
  }
}

/** The workspace this app serves: SLACK_TEAM_ID when pinned, else the auth.test team. */
async function teamOk(deps: CoreDeps, client: SlackClient, teamId: string): Promise<boolean> {
  const pinned = deps.config.slack?.teamId;
  const ok = pinned ? pinned === teamId : (await ensureInstallation(deps, client)).teamId === teamId;
  if (!ok) deps.log('warn', 'slack request from another workspace ignored');
  return ok;
}

export function registerSlackRoutes(app: Hono, deps: CoreDeps, ctx: SlackCtx): void {
  app.post('/slack/events', async (c) => {
    const r = await readRaw(c);
    if ('res' in r) return r.res;
    const client = slackEnabled(deps.config) ? ctx.client(deps) : null;
    if (!client) {
      // Inert: only the handshake, so the app can be created before the secrets are set.
      const ch = challengeOf(r.raw);
      return ch ? c.json({ challenge: ch }) : c.json({ ok: true });
    }
    if (!verified(c, deps, r.raw)) return unauthorized(c);
    const ch = challengeOf(r.raw);
    if (ch) return c.json({ challenge: ch });
    let json: unknown;
    try { json = JSON.parse(r.raw); } catch { return c.json({ ok: true }); }
    const p = EventCallback.safeParse(json);
    if (!p.success) return c.json({ ok: true });
    const { event: ev, team_id: teamId, event_id: eventId } = p.data;
    try {
      if (!(await teamOk(deps, client, teamId))) return c.json({ ok: true });
      // Plain human replies in a thread only (I11: never bots, apps, edits or other subtypes).
      if (ev.type !== 'message' || ev.subtype || ev.bot_id || ev.app_id || ev.edited !== undefined) return c.json({ ok: true });
      if (!ev.user || typeof ev.text !== 'string' || !ev.text.trim()) return c.json({ ok: true });
      if (!ev.thread_ts || ev.thread_ts === ev.ts) return c.json({ ok: true });
      if (ev.channel_type !== 'im' && ev.channel_type !== 'channel' && ev.channel_type !== 'group') return c.json({ ok: true });
      const inst = await ensureInstallation(deps, client).catch(() => null);
      if (inst?.botUserId && ev.user === inst.botUserId) return c.json({ ok: true });
      const tooLong = Buffer.byteLength(ev.text) > 12_000;
      const payload = {
        teamId, eventId, channel: ev.channel, channelType: ev.channel_type, user: ev.user,
        text: tooLong ? '' : ev.text.slice(0, MAX_SLACK_BODY), ts: ev.ts, threadTs: ev.thread_ts, ...(tooLong || ev.text.length > MAX_SLACK_BODY ? { tooLong: true } : {}),
      };
      await deps.db.asService(async (tx) => {
        const seen = await tx.query(`insert into public.slack_events_seen (event_id) values ($1) on conflict do nothing returning event_id`, [eventId]);
        if (seen.rowCount === 0) return; // a retry: already queued
        await deps.jobs.enqueue('slack.event', payload, { dedupeKey: `slack:ev:${eventId}`, tx });
      });
      return c.json({ ok: true });
    } catch (e) {
      deps.log('error', 'slack event failed', { err: e instanceof Error ? e.name : 'error' });
      return c.json(makeError('INTERNAL', 'internal error'), 500); // Slack retries; the dedupe makes that safe
    }
  });

  app.post('/slack/commands', async (c) => {
    const r = await readRaw(c);
    if ('res' in r) return r.res;
    const client = slackEnabled(deps.config) ? ctx.client(deps) : null;
    if (!client) return c.json({ response_type: 'ephemeral', text: 'Y is not connected to Slack yet.' });
    if (!verified(c, deps, r.raw)) return unauthorized(c);
    const form = Object.fromEntries(new URLSearchParams(r.raw));
    const p = SlashCommand.safeParse(form);
    if (!p.success) return c.json({ response_type: 'ephemeral', text: 'Y did not understand that command. Try `/y help`.' });
    try {
      if (!(await teamOk(deps, client, p.data.team_id))) return c.json({ response_type: 'ephemeral', text: 'This workspace is not connected to Y.' });
      return c.json(await handleCommand(deps, client, p.data));
    } catch (e) {
      deps.log('error', 'slack command failed', { err: e instanceof Error ? e.name : 'error' });
      return c.json({ response_type: 'ephemeral', text: 'Something went wrong in Y. Try again in a moment.' });
    }
  });

  app.post('/slack/interactivity', async (c) => {
    const r = await readRaw(c);
    if ('res' in r) return r.res;
    const client = slackEnabled(deps.config) ? ctx.client(deps) : null;
    if (!client) return c.body(null, 200);
    if (!verified(c, deps, r.raw)) return unauthorized(c);
    let json: unknown;
    try { json = JSON.parse(new URLSearchParams(r.raw).get('payload') ?? ''); } catch { return c.body(null, 200); }
    const p = BlockActions.safeParse(json);
    if (!p.success) return c.body(null, 200); // view_submission etc.: ignored
    try {
      if (!(await teamOk(deps, client, p.data.team.id))) return c.body(null, 200);
      await handleBlockActions(deps, client, p.data);
    } catch (e) {
      deps.log('error', 'slack action failed', { err: e instanceof Error ? e.name : 'error' });
    }
    return c.body(null, 200);
  });
}
