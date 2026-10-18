/** Replies from Slack: comments in mixed threads, confirmed owner instructions in own-agent threads (I2, I5). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verify } from 'node:crypto';

vi.mock('@y/safety', () => import('../messaging/test-fakes.js').then((m) => m.safety));
vi.mock('@y/domain', () => import('../messaging/test-fakes.js').then((m) => m.domain));
vi.mock('@y/retrieval', () => import('../messaging/test-fakes.js').then((m) => m.retrieval));

import { ownerInstructionSigningMessage } from '@y/schema';
import { ownerInstructionPublicKey } from '../messaging/signing.js';
import { seedTeam } from '../messaging/test-support.js';
import { SU, callTool, makeSlackEnv, seedPerson, type Person, type SlackEnv } from './test-support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let s: SlackEnv;
let alice: Person; let bob: Person; let eve: Person;
afterEach(async () => { await s?.env.db.close(); });

let evSeq = 0;
async function setup() {
  s = await makeSlackEnv();
  alice = await seedPerson(s.env.db, 'alice');
  bob = await seedPerson(s.env.db, 'bob');
  eve = await seedPerson(s.env.db, 'eve');
  await seedTeam(s.env.db, 'acme', [alice, bob]);
  await s.link(alice, SU.alice);
  await s.link(bob, SU.bob);
  await s.drain(); s.fake.reset();
}
const send = (p: Person, to: string, body: string) =>
  callTool(s.env, 'send_message', s.agent(p), { to, body, intent: 'question', idempotency_key: `key-${Math.random().toString(36).slice(2, 12)}` });
const bridgeFor = async (userId: string) =>
  (await s.env.db.query<{ thread_id: string; channel_id: string; thread_ts: string }>(
    `select thread_id, channel_id, thread_ts from public.thread_bridges where for_user_id = $1`, [userId])).rows[0]!;
async function reply(slackUser: string, b: { channel_id: string; thread_ts: string }, text: string, eventId = `Ev${String(++evSeq).padStart(8, '0')}`) {
  const res = await s.event({ type: 'message', user: slackUser, text, ts: `1700000500.${String(++evSeq).padStart(6, '0')}`, thread_ts: b.thread_ts, channel: b.channel_id, channel_type: 'im' }, { eventId });
  expect(res.status).toBe(200);
  await s.drain();
  return eventId;
}
const ephemerals = () => s.fake.of('postEphemeral').map((c) => c.args.text as string);
const ois = async () => (await s.env.db.query<Record<string, any>>(`select * from public.owner_instructions order by id`)).rows;
const pendings = async () => (await s.env.db.query<Record<string, any>>(`select * from public.slack_pending_instructions order by id`)).rows;

/** A mixed thread (alice-cc <-> bob-cc) with bob's Slack bridge. */
async function mixed() {
  const sent = await send(alice, bob.agentHandle, 'can you review my PR?');
  await s.drain();
  return { threadId: sent.body.output.thread_id.slice(2) as string, bridge: await bridgeFor(bob.userId) };
}

/** Alice <-> her own agent, with alice's bridge. */
async function ownThread() {
  const res = await s.env.app.request('/api/v1/threads', {
    method: 'POST', headers: { authorization: s.web(alice), 'content-type': 'application/json' }, body: JSON.stringify({ to: alice.agentHandle, body: 'start on the migration' }),
  });
  const t = (await res.json()) as any;
  await send(alice, t.thread.id, 'on it, which table first?');
  await s.drain();
  return { threadId: t.thread.id.slice(2) as string, bridge: await bridgeFor(alice.userId) };
}

describe('slack replies: comments', () => {
  it('posts a linked participant\'s reply as a human comment, once per event, and notifies the other side', async () => {
    await setup();
    const { threadId, bridge } = await mixed();
    expect(bridge.thread_id).toBe(threadId);
    s.fake.reset();
    const eventId = await reply(SU.bob, bridge, 'looks good &amp; ship it <@U0ALICE01>');
    const rows = (await s.env.db.query<Record<string, any>>(
      `select sender_kind, sender_id, trust, idempotency_key, body, state, verdict_id from public.messages where thread_id = $1 and sender_kind = 'user'`, [threadId])).rows;
    expect(rows).toEqual([expect.objectContaining({ sender_id: bob.userId, trust: 'human_comment', idempotency_key: `slack:${eventId}`, body: 'looks good & ship it @slack-user', state: 'delivered' })]);
    expect(rows[0]!.verdict_id).toBeTruthy();
    const toAlice = s.fake.of('postMessage').filter((c) => c.args.channel === 'D0ALICE01');
    expect(toAlice).toHaveLength(1);
    expect(s.fake.of('postMessage').filter((c) => c.args.channel === 'D0BOB0001')).toHaveLength(0);
    // I3: push events stay ids-only.
    for (const e of s.env.bus.events.filter((x) => x.type === 'message.new')) {
      expect(Object.keys(e.payload).sort()).toEqual(expect.arrayContaining(['messageId', 'threadId']));
      expect(JSON.stringify(e.payload)).not.toContain('ship it');
    }
    // Slack retry with the same event id: still one row.
    await reply(SU.bob, bridge, 'looks good &amp; ship it <@U0ALICE01>', eventId);
    expect((await s.env.db.query(`select count(*)::int as n from public.messages where thread_id = $1 and sender_kind = 'user'`, [threadId])).rows[0]).toEqual({ n: 1 });
  });

  it('refuses unlinked users, non-participants, unknown bridges and archived threads', async () => {
    await setup();
    const { threadId, bridge } = await mixed();
    s.fake.reset();
    await reply(SU.eve, bridge, 'hello?');
    expect(ephemerals()).toEqual(['Not delivered: link your Slack account with /y connect.']);
    await s.link(eve, SU.eve);
    await reply(SU.eve, bridge, 'hello?');
    expect(ephemerals()[1]).toBe("Not delivered: you're not part of this conversation.");
    // No bridge: silent.
    await reply(SU.bob, { channel_id: bridge.channel_id, thread_ts: '1699999999.000001' }, 'into the void');
    expect(ephemerals()).toHaveLength(2);
    await s.env.db.query(`update public.threads set state = 'archived' where id = $1`, [threadId]);
    await reply(SU.bob, bridge, 'too late');
    expect(ephemerals()[2]).toBe('Not delivered: this thread is archived.');
    expect((await s.env.db.query(`select count(*)::int as n from public.messages where sender_kind = 'user' and thread_id = $1`, [threadId])).rows[0]).toEqual({ n: 0 });
  });

  it('an instruct: prefix in a mixed thread asks to confirm an instruction', async () => {
    await setup();
    const { bridge } = await mixed();
    await s.env.db.query(`update public.agent_settings set remote_instructions = true where agent_id = $1`, [bob.agentId]);
    s.fake.reset();
    await reply(SU.bob, bridge, 'instruct: run the full test suite first');
    const p = await pendings();
    expect(p).toHaveLength(1);
    expect(p[0]!.body).toBe('run the full test suite first');
    expect(s.fake.of('postMessage')[0]!.args).toMatchObject({ channel: bridge.channel_id, threadTs: bridge.thread_ts, text: 'Send this to your agent?' });
    expect(await ois()).toEqual([]);
  });
});

describe('slack replies: owner instructions', () => {
  it('needs remote instructions on, and becomes a signed instruction only after Confirm', async () => {
    await setup();
    const { threadId, bridge } = await ownThread();
    s.fake.reset();
    await reply(SU.alice, bridge, 'start with the users table');
    expect(ephemerals()).toEqual(['Remote instructions are off for @alice-cc. Turn them on at https://web.test/settings and reply again.']);
    expect(await pendings()).toEqual([]);

    await s.env.db.query(`update public.agent_settings set remote_instructions = true where agent_id = $1`, [alice.agentId]);
    await reply(SU.alice, bridge, 'start with the users table');
    const [p] = await pendings();
    expect(p).toMatchObject({ state: 'pending', body: 'start with the users table', user_id: alice.userId });
    const prompt = s.fake.of('postMessage').at(-1)!.args;
    expect(prompt).toMatchObject({ threadTs: bridge.thread_ts, text: 'Send this to your agent?' });
    const confirm = JSON.stringify(prompt.blocks);
    expect(confirm).toContain(`${p!.id}|${alice.agentId}`);
    expect(await ois()).toEqual([]); // nothing reaches the agent before the click

    await s.action(SU.alice, 'y_oi_confirm', `${p!.id}|${alice.agentId}`, { channel: bridge.channel_id, ts: '1700000000.000777' });
    const [oi] = await ois();
    expect(oi).toMatchObject({ verified_via: 'slack', body: 'start with the users table', agent_id: alice.agentId, created_by_user_id: alice.userId, thread_id: threadId });
    const msg = ownerInstructionSigningMessage({
      id: `oi_${oi!.id}`, agent_id: oi!.agent_id, thread_id: `t_${threadId}`, body: oi!.body, verified_via: 'slack', created_at: new Date(oi!.created_at).toISOString(),
    });
    expect(verify(null, Buffer.from(msg), ownerInstructionPublicKey(s.env.deps.config), Buffer.from(oi!.sig, 'base64url'))).toBe(true);
    const ev = s.env.bus.events.filter((e) => e.type === 'owner_instruction.new');
    expect(ev).toHaveLength(1);
    expect(Object.keys(ev[0]!.payload).sort()).toEqual(['ownerInstructionId', 'threadId']);
    expect(s.fake.of('updateMessage').at(-1)!.args.text).toBe('Sent');
    expect((await pendings())[0]).toMatchObject({ state: 'confirmed', body: null, owner_instruction_id: oi!.id });

    // Second Confirm: already handled, still one instruction.
    await s.action(SU.alice, 'y_oi_confirm', `${p!.id}|${alice.agentId}`, { channel: bridge.channel_id, ts: '1700000000.000777' });
    expect(JSON.stringify(s.fake.of('updateMessage').at(-1)!.args.blocks)).toContain('Already handled.');
    expect(await ois()).toHaveLength(1);
    // The web /instruct path still stores verified_via 'web'.
    const web = await s.env.app.request(`/api/v1/threads/t_${threadId}/instruct`, {
      method: 'POST', headers: { authorization: s.web(alice), 'content-type': 'application/json' }, body: JSON.stringify({ body: 'from the web' }),
    });
    expect(web.status).toBe(200);
    expect((await ois()).map((o) => o.verified_via)).toEqual(['slack', 'web']);
  });

  it('cancel creates nothing; an expired prompt cannot be confirmed; another user cannot confirm', async () => {
    await setup();
    const { bridge } = await ownThread();
    await s.env.db.query(`update public.agent_settings set remote_instructions = true where agent_id = $1`, [alice.agentId]);
    await reply(SU.alice, bridge, 'first idea');
    const [p1] = await pendings();
    await s.action(SU.bob, 'y_oi_confirm', `${p1!.id}|${alice.agentId}`, { channel: bridge.channel_id });
    expect(ephemerals().at(-1)).toBe("This request isn't yours.");
    await s.action(SU.alice, 'y_oi_cancel', p1!.id, { channel: bridge.channel_id });
    expect(s.fake.of('updateMessage').at(-1)!.args.text).toBe('Cancelled');
    expect(await ois()).toEqual([]);

    await reply(SU.alice, bridge, 'second idea');
    const p2 = (await pendings()).find((x) => x.state === 'pending')!;
    s.advance(16 * 60_000);
    await s.action(SU.alice, 'y_oi_confirm', `${p2.id}|${alice.agentId}`, { channel: bridge.channel_id });
    expect(s.fake.of('updateMessage').at(-1)!.args.text).toBe('Expired');
    expect(await ois()).toEqual([]);
    expect((await pendings()).map((x) => x.state).sort()).toEqual(['cancelled', 'expired']);
  });

  it('an unattended agent: the prompt warns, and Confirm also records the owner confirm', async () => {
    await setup();
    const { bridge } = await ownThread();
    await s.env.db.query(`update public.agent_settings set remote_instructions = true where agent_id = $1`, [alice.agentId]);
    await s.env.db.query(`insert into public.session_leases (agent_id, session_id, listening, permission_mode) values ($1, 'sess-1', 'listening', 'bypassPermissions')`, [alice.agentId]);
    await reply(SU.alice, bridge, 'deploy the preview');
    const prompt = s.fake.of('postMessage').at(-1)!.args;
    expect(JSON.stringify(prompt.blocks)).toContain('runs unattended');
    const [p] = await pendings();
    await s.action(SU.alice, 'y_oi_confirm', `${p!.id}|${alice.agentId}`, { channel: bridge.channel_id });
    const [oi] = await ois();
    expect(oi).toMatchObject({ requires_confirm: true, confirmed_via: 'slack', verified_via: 'slack' });
    expect(oi!.confirmed_at).not.toBeNull();
  });
});
