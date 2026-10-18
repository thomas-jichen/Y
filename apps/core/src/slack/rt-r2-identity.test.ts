/** Red-team round 2 (#30): a suspended Y user cannot act through a Slack link. */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@y/safety', () => import('../messaging/test-fakes.js').then((m) => m.safety));
vi.mock('@y/domain', () => import('../messaging/test-fakes.js').then((m) => m.domain));
vi.mock('@y/retrieval', () => import('../messaging/test-fakes.js').then((m) => m.retrieval));

import { seedTeam } from '../messaging/test-support.js';
import { linkedUserFor } from './identity.js';
import { SU, callTool, makeSlackEnv, seedPerson, type Person, type SlackEnv } from './test-support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let s: SlackEnv;
let alice: Person; let bob: Person; let eve: Person;
afterEach(async () => { await s?.env.db.close(); });

const slackTeam = async () =>
  (await s.env.db.query<{ slack_team_id: string }>(`select slack_team_id from public.slack_identity_links where user_id = $1`, [bob.userId])).rows[0]!.slack_team_id;

describe('linkedUserFor (#30)', () => {
  it('treats a link to a suspended or deleted user as unlinked, and an active one as linked', async () => {
    s = await makeSlackEnv();
    bob = await seedPerson(s.env.db, 'bob');
    await s.link(bob, SU.bob);
    const team = await slackTeam();
    expect(await s.env.db.asService((tx) => linkedUserFor(tx, team, SU.bob))).toBe(bob.userId);
    await s.env.db.query(`update public.users set status = 'suspended' where id = $1`, [bob.userId]);
    expect(await s.env.db.asService((tx) => linkedUserFor(tx, team, SU.bob))).toBeNull();
    await s.env.db.query(`update public.users set status = 'deleted' where id = $1`, [bob.userId]);
    expect(await s.env.db.asService((tx) => linkedUserFor(tx, team, SU.bob))).toBeNull();
    await s.env.db.query(`update public.users set status = 'active' where id = $1`, [bob.userId]);
    expect(await s.env.db.asService((tx) => linkedUserFor(tx, team, SU.bob))).toBe(bob.userId);
  });

  it('refuses a review button click from a suspended user', async () => {
    s = await makeSlackEnv();
    alice = await seedPerson(s.env.db, 'alice');
    bob = await seedPerson(s.env.db, 'bob');
    eve = await seedPerson(s.env.db, 'eve');
    await seedTeam(s.env.db, 'acme', [alice, bob]);
    await s.link(bob, SU.bob);
    await s.drain(); s.fake.reset();

    await callTool(s.env, 'send_message', s.agent(eve), { to: bob.agentHandle, body: 'Hi, I maintain a library you use', intent: 'question', idempotency_key: 'key-r2-identity-1' });
    await s.drain();
    const rv = (await s.env.db.query<{ id: string }>(`select id from public.review_items where kind = 'dm_request'`)).rows[0]!;
    const msg = s.fake.of('postMessage').find((c) => c.args.text.startsWith('New DM request'))!.args;

    await s.env.db.query(`update public.users set status = 'suspended' where id = $1`, [bob.userId]);
    await s.action(SU.bob, 'y_rv_reject', `rv_${rv.id}`, { channel: msg.channel, ts: '1700000000.000009' });
    expect(s.fake.of('postEphemeral').map((c) => c.args.text)).toEqual(['Not delivered: link your Slack account with /y connect.']);
    const after = (await s.env.db.query<{ state: string }>(`select state from public.review_items where id = $1`, [rv.id])).rows[0]!;
    expect(after.state).toBe('pending');
  });
});
