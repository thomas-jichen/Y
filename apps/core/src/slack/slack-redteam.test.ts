/** Red-team regressions (slack cluster): #52 prompt retry, #70 relinked bridges, #93 confirm recovery, #94 job payload scrub. */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@y/safety', () => import('../messaging/test-fakes.js').then((m) => m.safety));
vi.mock('@y/domain', () => import('../messaging/test-fakes.js').then((m) => m.domain));
vi.mock('@y/retrieval', () => import('../messaging/test-fakes.js').then((m) => m.retrieval));

import { seedTeam } from '../messaging/test-support.js';
import { SlackApiError } from './fake-client.js';
import { renderForUpdate } from './notify.js';
import { SU, callTool, makeSlackEnv, seedPerson, type Person, type SlackEnv } from './test-support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let s: SlackEnv;
let alice: Person; let bob: Person;
afterEach(async () => { await s?.env.db.close(); });

let evSeq = 0;
async function setup(links: Array<[() => Person, string]> = [[() => alice, SU.alice], [() => bob, SU.bob]]) {
  s = await makeSlackEnv();
  alice = await seedPerson(s.env.db, 'alice');
  bob = await seedPerson(s.env.db, 'bob');
  await seedTeam(s.env.db, 'acme', [alice, bob]);
  for (const [p, u] of links) await s.link(p(), u);
  await s.drain(); s.fake.reset();
}
const send = (p: Person, to: string, body: string) =>
  callTool(s.env, 'send_message', s.agent(p), { to, body, intent: 'question', idempotency_key: `key-${Math.random().toString(36).slice(2, 12)}` });
const bridges = async () =>
  (await s.env.db.query<{ thread_id: string; channel_id: string; thread_ts: string; for_user_id: string | null }>(
    `select thread_id, channel_id, thread_ts, for_user_id from public.thread_bridges order by created_at`)).rows;
async function reply(slackUser: string, b: { channel_id: string; thread_ts: string }, text: string, eventId = `Ev9${String(++evSeq).padStart(7, '0')}`) {
  const res = await s.event({ type: 'message', user: slackUser, text, ts: `1700000600.${String(++evSeq).padStart(6, '0')}`, thread_ts: b.thread_ts, channel: b.channel_id, channel_type: 'im' }, { eventId });
  expect(res.status).toBe(200);
  await s.drain();
  return eventId;
}
const ephemerals = () => s.fake.of('postEphemeral').map((c) => c.args.text as string);
const prompts = () => s.fake.of('postMessage').filter((c) => c.args.text === 'Send this to your agent?');
const ois = async () => (await s.env.db.query<Record<string, any>>(`select * from public.owner_instructions order by id`)).rows;
const pendings = async () => (await s.env.db.query<Record<string, any>>(`select * from public.slack_pending_instructions order by id`)).rows;
const eventJobs = async () => (await s.env.db.query<{ id: string; state: string; attempts: number; payload: Record<string, unknown> }>(
  `select id::text as id, state, attempts, payload from public.jobs where topic = 'slack.event' order by id`)).rows;
/** Make queued jobs due now (fail_job backs off against the DB clock). */
const due = () => s.env.db.query(`update public.jobs set run_after = now() - interval '1 second' where state = 'queued'`);

/** Alice <-> her own agent, remote instructions on, with alice's bridge. */
async function ownThread() {
  const res = await s.env.app.request('/api/v1/threads', {
    method: 'POST', headers: { authorization: s.web(alice), 'content-type': 'application/json' }, body: JSON.stringify({ to: alice.agentHandle, body: 'start on the migration' }),
  });
  const t = (await res.json()) as any;
  await send(alice, t.thread.id, 'on it, which table first?');
  await s.drain();
  await s.env.db.query(`update public.agent_settings set remote_instructions = true where agent_id = $1`, [alice.agentId]);
  const bridge = (await bridges()).find((b) => b.for_user_id === alice.userId)!;
  return { threadId: t.thread.id.slice(2) as string, bridge };
}

describe('#52 slack.event retry re-posts a Confirm prompt that never went out', () => {
  it('re-prompts once after a retryable postMessage failure, never twice', async () => {
    await setup();
    const { bridge } = await ownThread();
    s.fake.reset();
    s.fake.failNext.postMessage = new SlackApiError('chat.postMessage', 'ratelimited');
    await reply(SU.alice, bridge, 'start with the users table');
    expect(prompts()).toHaveLength(1); // the failed call
    expect((await eventJobs()).at(-1)).toMatchObject({ state: 'queued', attempts: 1 });
    await due(); await s.drain();

    const [p] = await pendings();
    expect(p).toMatchObject({ state: 'pending', body: 'start with the users table' });
    expect(p!.prompted_at).not.toBeNull();
    expect(prompts()).toHaveLength(2);
    expect(JSON.stringify(prompts().at(-1)!.args.blocks)).toContain(`${p!.id}|${alice.agentId}`);
    expect(ephemerals()).toEqual([]);
    expect((await eventJobs()).at(-1)).toMatchObject({ state: 'done', attempts: 2 });

    // Another run of the same event (a lease takeover) after a successful prompt: silent.
    await s.env.db.query(`update public.jobs set state = 'queued', run_after = now() - interval '1 second', payload = payload || $1::jsonb where topic = 'slack.event'`,
      [JSON.stringify({ text: 'start with the users table' })]);
    await s.drain();
    expect(prompts()).toHaveLength(2);
    expect(await pendings()).toHaveLength(1);
  });

  it('does not re-prompt an expired or decided row on retry', async () => {
    await setup();
    const { bridge } = await ownThread();
    s.fake.reset();
    s.fake.failNext.postMessage = new SlackApiError('chat.postMessage', 'ratelimited');
    await reply(SU.alice, bridge, 'start with the users table');
    s.advance(16 * 60_000);
    await due(); await s.drain();
    expect(prompts()).toHaveLength(1);
    expect((await pendings())[0]).toMatchObject({ state: 'expired', body: null });
  });
});

describe('#70 bridges after a Slack user is relinked to another Y account', () => {
  it('a reply in the old bridge is refused, and a new notice re-points the bridge', async () => {
    await setup([[() => bob, SU.bob]]);
    const sent = await send(alice, bob.agentHandle, 'can you review my PR?');
    await s.drain();
    const threadId = sent.body.output.thread_id.slice(2) as string;
    const [old] = await bridges();
    expect(old).toMatchObject({ thread_id: threadId, channel_id: 'D0BOB0001', for_user_id: bob.userId });

    // U0BOB0001 is relinked to alice's Y account (same bot IM channel).
    await s.link(alice, SU.bob);
    await s.drain(); s.fake.reset();
    await reply(SU.bob, old!, 'my reply');
    expect(ephemerals()).toEqual(['Not delivered: this Slack thread was for a different Y account. Reply to a newer Y notice.']);
    expect((await s.env.db.query(`select count(*)::int as n from public.messages where sender_kind = 'user'`)).rows[0]).toEqual({ n: 0 });

    // bob's agent answers: alice gets a fresh notice in that IM, and the bridge follows it.
    await send(bob, `t_${threadId}`, 'sure, sending notes');
    await s.drain();
    const top = s.fake.of('postMessage').filter((c) => c.args.channel === 'D0BOB0001' && !c.args.threadTs);
    expect(top).toHaveLength(1);
    const now = await bridges();
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ thread_id: threadId, channel_id: 'D0BOB0001', for_user_id: alice.userId });
    expect(now[0]!.thread_ts).not.toBe(old!.thread_ts);

    // A reply to the new notice is alice's comment.
    s.fake.reset();
    const eventId = await reply(SU.bob, now[0]!, 'thanks, will look');
    expect(ephemerals()).toEqual([]);
    const rows = (await s.env.db.query<Record<string, any>>(
      `select sender_id, idempotency_key from public.messages where thread_id = $1 and sender_kind = 'user'`, [threadId])).rows;
    expect(rows).toEqual([{ sender_id: alice.userId, idempotency_key: `slack:${eventId}` }]);
  });
});

describe('#93 an unexpected error after the Confirm CAS', () => {
  it('nothing stored: the row is cancelled and the message says not sent', async () => {
    await setup();
    const { bridge } = await ownThread();
    await reply(SU.alice, bridge, 'start with the users table');
    const [p] = await pendings();
    const db = s.env.deps.db;
    const orig = db.asUser;
    db.asUser = (async () => { db.asUser = orig; throw new Error('transient'); }) as typeof db.asUser;
    s.fake.reset();
    await s.action(SU.alice, 'y_oi_confirm', `${p!.id}|${alice.agentId}`, { channel: bridge.channel_id, ts: '1700000000.000777' });
    db.asUser = orig;
    expect(await ois()).toEqual([]);
    expect((await pendings())[0]).toMatchObject({ state: 'cancelled', body: null, owner_instruction_id: null });
    expect(JSON.stringify(s.fake.of('updateMessage').at(-1)!.args.blocks)).toContain('Not sent');
    // A second click cannot issue anything.
    await s.action(SU.alice, 'y_oi_confirm', `${p!.id}|${alice.agentId}`, { channel: bridge.channel_id, ts: '1700000000.000777' });
    expect(await ois()).toEqual([]);
  });

  it('stored before the error: the row is linked and the message says sent', async () => {
    await setup();
    const { bridge } = await ownThread();
    await reply(SU.alice, bridge, 'start with the users table');
    const [p] = await pendings();
    const bus = s.env.deps.bus;
    const orig = bus.publish;
    bus.publish = (async () => { bus.publish = orig; throw new Error('transient'); }) as typeof bus.publish;
    s.fake.reset();
    await s.action(SU.alice, 'y_oi_confirm', `${p!.id}|${alice.agentId}`, { channel: bridge.channel_id, ts: '1700000000.000777' });
    bus.publish = orig;
    const all = await ois();
    expect(all).toHaveLength(1);
    expect((await pendings())[0]).toMatchObject({ state: 'confirmed', owner_instruction_id: all[0]!.id });
    expect(s.fake.of('updateMessage').at(-1)!.args.text).toBe('Sent');
  });
});

describe('#93 review follow-ups', () => {
  it('stored and linked, then the message update fallback throws: never says not sent', async () => {
    await setup();
    const { bridge } = await ownThread();
    await reply(SU.alice, bridge, 'start with the users table');
    const [p] = await pendings();
    const jobs = s.env.deps.jobs;
    const orig = jobs.enqueue;
    jobs.enqueue = (async () => { jobs.enqueue = orig; throw new Error('transient'); }) as typeof jobs.enqueue;
    s.fake.reset();
    s.fake.failNext.updateMessage = new SlackApiError('chat.update', 'ratelimited');
    await s.action(SU.alice, 'y_oi_confirm', `${p!.id}|${alice.agentId}`, { channel: bridge.channel_id, ts: '1700000000.000778' });
    jobs.enqueue = orig;
    const all = await ois();
    expect(all).toHaveLength(1);
    expect((await pendings())[0]).toMatchObject({ state: 'confirmed', owner_instruction_id: all[0]!.id });
    const texts = s.fake.of('updateMessage').map((c) => c.args.text);
    expect(texts).not.toContain('Not sent');
    // A second click still reports it as handled, and issues nothing more.
    await s.action(SU.alice, 'y_oi_confirm', `${p!.id}|${alice.agentId}`, { channel: bridge.channel_id, ts: '1700000000.000778' });
    expect(await ois()).toHaveLength(1);
  });

  it('the fallback re-render never claims sent for a confirmed row with no stored instruction', async () => {
    await setup();
    const { bridge } = await ownThread();
    await reply(SU.alice, bridge, 'start with the users table');
    const [p] = await pendings();
    // A crash between the Confirm CAS and the owner instruction insert leaves exactly this row.
    await s.env.db.query(`update public.slack_pending_instructions set state = 'confirmed', body = null, decided_at = now() where id = $1`, [p!.id]);
    const msg = await s.env.deps.db.asService((tx) => renderForUpdate(tx, 'https://y.test', 'pending', p!.id));
    expect(msg).not.toBeNull();
    expect(JSON.stringify(msg!.blocks)).not.toContain('Sent to');
    expect(JSON.stringify(msg!.blocks)).toContain('Already handled');
  });
});

describe('#70 legacy bridges with no for_user_id', () => {
  it('a new notice claims the legacy bridge so replies to it are delivered', async () => {
    await setup([[() => bob, SU.bob]]);
    const sent = await send(alice, bob.agentHandle, 'can you review my PR?');
    await s.drain();
    const threadId = sent.body.output.thread_id.slice(2) as string;
    await s.env.db.query(`update public.thread_bridges set for_user_id = null`);
    const [legacy] = await bridges();
    s.fake.reset();

    await send(alice, `t_${threadId}`, 'one more thing: the tests');
    await s.drain();
    const top = s.fake.of('postMessage').filter((c) => c.args.channel === 'D0BOB0001' && !c.args.threadTs);
    expect(top).toHaveLength(1);
    const now = await bridges();
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ thread_id: threadId, channel_id: 'D0BOB0001', for_user_id: bob.userId });
    expect(now[0]!.thread_ts).not.toBe(legacy!.thread_ts);

    s.fake.reset();
    const eventId = await reply(SU.bob, now[0]!, 'looking now');
    expect(ephemerals()).toEqual([]);
    const rows = (await s.env.db.query<Record<string, any>>(
      `select sender_id, idempotency_key from public.messages where thread_id = $1 and sender_kind = 'user'`, [threadId])).rows;
    expect(rows).toEqual([{ sender_id: bob.userId, idempotency_key: `slack:${eventId}` }]);
  });
});

describe('#94 finished slack.event jobs keep no reply text', () => {
  it('keeps the text across a retry and drops it once the job is done', async () => {
    await setup();
    const { bridge } = await ownThread();
    s.fake.failNext.postMessage = new SlackApiError('chat.postMessage', 'ratelimited');
    await reply(SU.alice, bridge, 'instruct: use the staging key');
    const [j1] = await eventJobs();
    expect(j1).toMatchObject({ state: 'queued' });
    expect(j1!.payload.text).toBe('instruct: use the staging key');
    await due(); await s.drain();
    const [j2] = await eventJobs();
    expect(j2!.state).toBe('done');
    expect(j2!.payload).not.toHaveProperty('text');
    expect(j2!.payload).toMatchObject({ eventId: expect.any(String), channel: bridge.channel_id });
    expect(prompts()).toHaveLength(2);
  });

  it('drops it from dead jobs too', async () => {
    await setup();
    const { bridge } = await ownThread();
    s.fake.failNext.postMessage = new SlackApiError('chat.postMessage', 'ratelimited');
    const res = await s.event({ type: 'message', user: SU.alice, text: 'secret plan', ts: '1700000700.000001', thread_ts: bridge.thread_ts, channel: bridge.channel_id, channel_type: 'im' });
    expect(res.status).toBe(200);
    await s.env.db.query(`update public.jobs set max_attempts = 1 where topic = 'slack.event'`);
    await s.drain();
    const [j] = await eventJobs();
    expect(j!.state).toBe('dead');
    expect(j!.payload).not.toHaveProperty('text');
  });
});
