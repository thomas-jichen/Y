/** /y connect, POST /api/v1/slack/link, unlink, /y disconnect, /y status (PGlite, fake Slack client). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackLinkPreview, SlackStatus } from '@y/schema';

vi.mock('@y/safety', () => import('../messaging/test-fakes.js').then((m) => m.safety));
vi.mock('@y/domain', () => import('../messaging/test-fakes.js').then((m) => m.domain));
vi.mock('@y/retrieval', () => import('../messaging/test-fakes.js').then((m) => m.retrieval));

import { sha256Hex } from '../platform/util.js';
import { SU, TEAM, makeSlackEnv, seedPerson, type SlackEnv } from './test-support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let s: SlackEnv;
afterEach(async () => { await s?.env.db.close(); });

const tokenOf = (reply: any) => new URL(reply.blocks[1].elements[0].url as string).searchParams.get('token')!;
const post = (auth: string, path: string, body: unknown) =>
  s.env.app.request(path, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const getStatus = async (auth: string) => SlackStatus.parse(await (await s.env.app.request('/api/v1/slack/status', { headers: { authorization: auth } })).json());

describe('slack linking', () => {
  it('links through a single-use web link and turns Slack notifications on', async () => {
    s = await makeSlackEnv();
    const alice = await seedPerson(s.env.db, 'alice');
    const reply = await s.command(SU.alice, 'connect');
    expect(reply.response_type).toBe('ephemeral');
    const url = reply.blocks[1].elements[0].url as string;
    expect(url).toMatch(/^https:\/\/web\.test\/slack\/link\?token=ysl_[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(reply);
    const rows = (await s.env.db.query<{ token_hash: string; slack_user_id: string }>(`select token_hash, slack_user_id from public.slack_link_tokens`)).rows;
    expect(rows).toEqual([{ token_hash: sha256Hex(token), slack_user_id: SU.alice }]);
    expect(JSON.stringify(rows)).not.toContain(token);
    // auth.test cached into slack_installations.
    expect((await s.env.db.query(`select slack_team_id, team_name from public.slack_installations`)).rows).toEqual([{ slack_team_id: TEAM, team_name: 'Test Workspace' }]);

    expect(await getStatus(s.web(alice))).toEqual({ available: true, linked: false, notifications: false, feedChannels: [] });
    const res = await post(s.web(alice), '/api/v1/slack/link', { token });
    expect(res.status).toBe(200);
    const st = SlackStatus.parse(await res.json());
    expect(st).toMatchObject({ available: true, linked: true, slackUserId: SU.alice, workspaceName: 'Test Workspace', notifications: true });
    expect((await s.env.db.query(`select channels from public.notification_prefs where user_id = $1`, [alice.userId])).rows[0]).toEqual({ channels: { web: true, slack: true } });

    // Welcome DM through the job queue.
    await s.drain();
    const posts = s.fake.of('postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.args.text).toBe("You're connected to Y");

    // Reuse -> 404.
    const again = await post(s.web(alice), '/api/v1/slack/link', { token });
    expect(again.status).toBe(404);
  });

  it('refuses expired tokens, agents, and bad input', async () => {
    s = await makeSlackEnv();
    const alice = await seedPerson(s.env.db, 'alice');
    const token = tokenOf(await s.command(SU.alice, 'connect'));
    expect((await post(s.agent(alice), '/api/v1/slack/link', { token })).status).toBe(403);
    expect((await post(s.web(alice), '/api/v1/slack/link', { token: 'nope' })).status).toBe(400);
    await s.env.db.query(`update public.slack_link_tokens set expires_at = now() - interval '1 minute'`);
    expect((await post(s.web(alice), '/api/v1/slack/link', { token })).status).toBe(404);
    expect((await s.env.db.query(`select count(*)::int as n from public.slack_identity_links`)).rows[0]).toEqual({ n: 0 });
  });

  it('unlinks from the web and from Slack', async () => {
    s = await makeSlackEnv();
    const alice = await seedPerson(s.env.db, 'alice');
    await s.link(alice, SU.alice);
    const res = await post(s.web(alice), '/api/v1/slack/unlink', {});
    expect(res.status).toBe(200);
    expect(SlackStatus.parse(await res.json())).toMatchObject({ linked: false, notifications: false });
    const row = (await s.env.db.query<{ revoked_at: Date | null }>(`select revoked_at from public.slack_identity_links`)).rows[0]!;
    expect(row.revoked_at).not.toBeNull();
    expect((await s.env.db.query(`select channels from public.notification_prefs where user_id = $1`, [alice.userId])).rows[0]).toEqual({ channels: { web: true, slack: false } });
    // An agent context cannot unlink (definer checks is_human()).
    await expect(s.env.db.asUser({ sub: alice.userId, agent_id: alice.agentId, via: 'install' }, (tx) => tx.query('select api.unlink_slack()'))).rejects.toThrow();

    await s.link(alice, SU.alice);
    expect((await s.command(SU.alice, 'status')).text).toBeDefined();
    const d = await s.command(SU.alice, 'disconnect');
    expect(d.blocks[0].text.text).toMatch(/^Disconnected/);
    expect(await getStatus(s.web(alice))).toMatchObject({ linked: false, notifications: false });
    expect((await s.command(SU.alice, 'disconnect')).blocks[0].text.text).toBe("This Slack account isn't linked.");
  });

  it('status shows feed channels and /y status replies', async () => {
    s = await makeSlackEnv();
    const alice = await seedPerson(s.env.db, 'alice');
    await s.env.db.query(`insert into public.teams (slug, name) values ('acme', 'Acme')`);
    await s.env.db.query(`insert into public.team_members (team_id, user_id) select id, $1 from public.teams where slug = 'acme'`, [alice.userId]);
    await s.link(alice, SU.alice);
    const f = await s.command(SU.alice, 'feed', { channel: 'C0FEED001' });
    expect(f.text).toBe('Y feed on');
    expect((await getStatus(s.web(alice))).feedChannels).toEqual([{ teamSlug: 'acme', channelId: 'C0FEED001' }]);
    const st = await s.command(SU.alice, 'status');
    expect(st.blocks[0].text.text).toContain('Linked to *@alice*');
    expect((await s.command(SU.alice, 'help')).text).toBe('Y commands');
  });

  it('previews a link without spending it, and links only on a fresh-login POST (forwarded-link defence, I5)', async () => {
    s = await makeSlackEnv();
    const victim = await seedPerson(s.env.db, 'alice');
    // Eve runs /y connect and forwards her link to alice.
    const token = tokenOf(await s.command(SU.eve, 'connect', { userName: 'eve.s' }));
    const pv = await post(s.web(victim), '/api/v1/slack/link/preview', { token });
    expect(pv.status).toBe(200);
    // The page shows whose Slack account this is before any click.
    expect(SlackLinkPreview.parse(await pv.json())).toMatchObject({ slackUserId: SU.eve, slackUserName: 'eve.s', workspaceName: 'Test Workspace' });
    // Previewing (even twice) does not spend the token or link anything.
    expect((await post(s.web(victim), '/api/v1/slack/link/preview', { token })).status).toBe(200);
    expect((await s.env.db.query(`select used_at from public.slack_link_tokens`)).rows[0]).toEqual({ used_at: null });
    expect((await s.env.db.query(`select count(*)::int as n from public.slack_identity_links`)).rows[0]).toEqual({ n: 0 });
    expect(await getStatus(s.web(victim))).toMatchObject({ linked: false, notifications: false });

    // A stale login cannot complete a link (step-up), and the token survives.
    const stale = await post(s.web(victim, { authTime: Math.floor(s.now().getTime() / 1000) - 13 * 3600 }), '/api/v1/slack/link', { token });
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as any).error.code).toBe('STEP_UP_REQUIRED');
    const noAuthTime = await post(s.web(victim, { authTime: null }), '/api/v1/slack/link', { token });
    expect(((await noAuthTime.json()) as any).error.code).toBe('STEP_UP_REQUIRED');
    expect((await s.env.db.query(`select count(*)::int as n from public.slack_identity_links`)).rows[0]).toEqual({ n: 0 });

    // Bad, unknown, used and expired tokens preview as 404; agents cannot preview.
    expect((await post(s.web(victim), '/api/v1/slack/link/preview', { token: 'nope' })).status).toBe(400);
    expect((await post(s.web(victim), '/api/v1/slack/link/preview', { token: 'ysl_' + 'A'.repeat(43) })).status).toBe(404);
    expect((await post(s.agent(victim), '/api/v1/slack/link/preview', { token })).status).toBe(403);
    expect((await post(s.web(victim), '/api/v1/slack/link', { token })).status).toBe(200);
    expect((await post(s.web(victim), '/api/v1/slack/link/preview', { token })).status).toBe(404);
    const t2 = tokenOf(await s.command(SU.eve, 'connect'));
    const p2 = SlackLinkPreview.parse(await (await post(s.web(victim), '/api/v1/slack/link/preview', { token: t2 })).json());
    expect(p2.slackUserName).toBeUndefined();
    await s.env.db.query(`update public.slack_link_tokens set expires_at = now() - interval '1 minute' where used_at is null`);
    expect((await post(s.web(victim), '/api/v1/slack/link/preview', { token: t2 })).status).toBe(404);
  });
});
