/** /y feed and the team feed card for published team activities (never private ones). */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@y/safety', () => import('../messaging/test-fakes.js').then((m) => m.safety));
vi.mock('@y/domain', () => import('../messaging/test-fakes.js').then((m) => m.domain));
vi.mock('@y/retrieval', () => import('../messaging/test-fakes.js').then((m) => m.retrieval));

import { SlackApiError } from './client.js';
import { SU, makeSlackEnv, seedPerson, type Person, type SlackEnv } from './test-support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let s: SlackEnv;
let alice: Person; let bob: Person;
afterEach(async () => { await s?.env.db.close(); });

async function team(slug: string, members: [Person, string][]) {
  const id = (await s.env.db.query<{ id: string }>(`insert into public.teams (slug, name) values ($1, $2) returning id`, [slug, slug])).rows[0]!.id;
  for (const [p, role] of members) await s.env.db.query(`insert into public.team_members (team_id, user_id, role) values ($1, $2, $3)`, [id, p.userId, role]);
  return id;
}
const feedRows = async () => (await s.env.db.query(`select channel_id from public.team_slack_channels`)).rows;
const text = (r: any) => r.blocks?.[0]?.text?.text ?? r.text;

async function activity(teamId: string | null, title: string) {
  const id = (await s.env.db.query<{ id: string }>(
    `insert into public.activities (agent_id, team_id, status, screen_action, title, summary, tool_calls, tokens_total, wall_ms, turns, outcome_status)
     values ($1, $2, 'distilling', 'allow', $3, 'SECRET-SUMMARY', 42, 123456, 3840000, 7, 'shipped') returning id`, [alice.agentId, teamId, title])).rows[0]!.id;
  await s.queue.enqueue('publish', { activityId: id }, { dedupeKey: `publish:${id}` });
  await s.drain();
  return id;
}

describe('team feed', () => {
  it('sets and clears the feed channel with team permissions', async () => {
    s = await makeSlackEnv();
    alice = await seedPerson(s.env.db, 'alice');
    bob = await seedPerson(s.env.db, 'bob');
    await team('open', [[alice, 'member'], [bob, 'member']]);
    await s.link(alice, SU.alice);
    await s.link(bob, SU.bob);

    expect(text(await s.command(SU.alice, 'feed', { channel: 'D0CHAN001' }))).toBe('Run this in a channel.');
    expect(text(await s.command(SU.carol, 'feed'))).toContain('/y connect');
    // No owner/admin rows: any member may set it.
    const on = await s.command(SU.alice, 'feed', { channel: 'C0FEED001' });
    expect(on.text).toBe('Y feed on');
    expect(await feedRows()).toEqual([{ channel_id: 'C0FEED001' }]);
    expect(text(await s.command(SU.alice, 'feed off', { channel: 'C0FEED001' }))).toContain('is off');
    expect(await feedRows()).toEqual([]);

    // With an admin, plain members are refused.
    await team('strict', [[alice, 'member'], [bob, 'admin']]);
    expect(text(await s.command(SU.alice, 'feed', { channel: 'C0FEED001' }))).toContain('Pick a team');
    expect(text(await s.command(SU.alice, 'feed strict', { channel: 'C0FEED001' }))).toBe('Only a team owner or admin can set the feed channel.');
    const g = await s.command(SU.bob, 'feed strict', { channel: 'G0PRIV001' });
    expect(text(g)).toContain('/invite @Y');
    expect(await feedRows()).toEqual([{ channel_id: 'G0PRIV001' }]);
  });

  it('posts a compact card for a published team activity, never for a private one', async () => {
    s = await makeSlackEnv();
    alice = await seedPerson(s.env.db, 'alice');
    const teamId = await team('acme', [[alice, 'owner']]);
    await s.link(alice, SU.alice);
    await s.command(SU.alice, 'feed', { channel: 'C0FEED001' });
    await s.drain(); s.fake.reset();

    const id = await activity(teamId, 'Fixed the <!channel> flaky test');
    const cards = s.fake.of('postMessage').filter((c) => c.args.channel === 'C0FEED001');
    expect(cards).toHaveLength(1);
    const card = cards[0]!.args;
    expect(card.text).toBe('@alice-cc finished a session');
    expect(card.threadTs).toBeUndefined();
    const json = JSON.stringify(card.blocks);
    expect(json).toContain('Fixed the &lt;!channel&gt; flaky test');
    expect(json).toContain('42');
    expect(json).toContain('123.5k');
    expect(json).toContain('1h 4m');
    expect(json).toContain(`https://web.test/activity/a_${id}`);
    expect(json).not.toContain('SECRET-SUMMARY');

    s.fake.reset();
    await activity(null, 'Private work');
    expect(s.fake.of('postMessage')).toEqual([]);
  });

  it('completes the job when the bot is not in the channel', async () => {
    s = await makeSlackEnv();
    alice = await seedPerson(s.env.db, 'alice');
    const teamId = await team('acme', [[alice, 'owner']]);
    await s.link(alice, SU.alice);
    await s.command(SU.alice, 'feed', { channel: 'C0FEED001' });
    await s.drain();
    s.fake.failNext.postMessage = new SlackApiError('chat.postMessage', 'not_in_channel');
    const id = await activity(teamId, 'Some work');
    const job = (await s.env.db.query(`select state, attempts from public.jobs where dedupe_key = $1`, [`slack:feed:${id}`])).rows[0];
    expect(job).toEqual({ state: 'done', attempts: 1 });
  });
});
