/**
 * Presence on PGlite: derived from signals (0010_presence.sql): turn reports
 * on the pulse (`active`), lease heartbeats, and ingests as a fallback for
 * listeners that don't report turns. Refreshed by the pulse heartbeat, ingest
 * and the presence_sweep job, one ids-only `presence` event per actual change
 * (owner + owner's teammates), and read back by status, /me and agent refs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Me, StreamEvent } from '@y/schema';
import { fx } from '@y/schema/fixtures';
import { internalMcpModule } from '../internal-mcp/index.js';
import { messagingModule } from '../messaging/index.js';
import {
  agentCaller,
  callTool,
  makeEnv,
  seedPerson,
  seedTeam,
  webCaller,
  type Person,
  type TestEnv,
} from '../messaging/test-support.js';
import { platformModule } from './index.js';
import { loadAgentRefs } from './mappers.js';
import { PLATFORM_JOBS } from './pipeline.js';
import { refreshPresence } from './presence.js';

let env: TestEnv;
let alice: Person;
let bob: Person;
let carol: Person;
let A: string;
let B: string;
let C: string;

const stored = async (agentId: string) =>
  (await env.db.query<{ presence: string }>('select presence::text as presence from public.agent_presence where agent_id = $1', [agentId])).rows[0]?.presence;
const presenceEvents = () => env.bus.events.filter((e) => e.type === 'presence');
const pulse = (token: string, sid: string, active?: '0' | '1') =>
  env.app.request(`/api/v1/pulse?wait=0&sessionId=${sid}${active ? `&active=${active}` : ''}`, {
    headers: { authorization: token, 'x-y-session': sid },
  });
const NO_DOORBELL = { url: null, publishableKey: null };
const DOORBELL = { url: 'https://abcdefghijklmnop.supabase.co', publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz' };
const setDoorbell = (on: boolean) => {
  env.deps.config.supabase = { ...env.deps.config.supabase, ...(on ? DOORBELL : NO_DOORBELL) };
};

beforeAll(async () => {
  env = await makeEnv([platformModule, messagingModule, internalMcpModule]);
  alice = await seedPerson(env.db, 'alice');
  bob = await seedPerson(env.db, 'bob');
  carol = await seedPerson(env.db, 'carol');
  await seedTeam(env.db, 'acme', [alice, bob]);
  await seedTeam(env.db, 'other', [carol]);
  A = env.token('alice-agent', agentCaller(alice));
  B = env.token('bob-agent', agentCaller(bob));
  C = env.token('carol-agent', agentCaller(carol));
}, 180_000);

afterAll(async () => {
  await env?.db.close();
});

beforeEach(async () => {
  // Every case starts from no signals and everyone stored away.
  await env.db.query('delete from public.session_leases');
  await env.db.query('delete from public.sessions');
  await env.db.query(`update public.agent_presence set presence = 'away'`);
  env.bus.events.length = 0;
  setDoorbell(false);
});

describe('presence', () => {
  it('a new agent is away and the status tool no longer reports an idle agent as live', async () => {
    expect(await stored(alice.agentId)).toBe('away');
    const s = await callTool(env, 'status', A, {});
    expect(s.status).toBe(200);
    expect(s.body.output.agent.presence).toBe('away');
  });

  it('a turn reported on the lease is live; it decays to listening, then away', async () => {
    await env.db.query(
      `insert into public.session_leases (agent_id, session_id, listening, last_heartbeat_at, active_at, reports_turns)
       values ($1, 's-a', 'listening', now(), now() - interval '1 minute', true)`,
      [alice.agentId],
    );
    expect(await refreshPresence(env.deps, [alice.agentId])).toEqual([{ agentId: alice.agentId, ownerUserId: alice.userId, presence: 'live' }]);

    // No turn report for 3 min (> 150 s): still heartbeating, so listening.
    await env.db.query(`update public.session_leases set active_at = now() - interval '3 minutes'`);
    expect((await refreshPresence(env.deps, [alice.agentId]))[0]?.presence).toBe('listening');

    await env.db.query(`update public.session_leases set last_heartbeat_at = now() - interval '2 minutes'`);
    expect((await refreshPresence(env.deps, [alice.agentId]))[0]?.presence).toBe('away');

    // Doorbell listeners heartbeat every 5 min: a 2 min old lease still listens. The window follows
    // the transport core hands out (Realtime configured), not core's run mode.
    setDoorbell(true);
    env.deps.config.mode = 'server';
    expect((await refreshPresence(env.deps, [alice.agentId]))[0]?.presence).toBe('listening');
    setDoorbell(false);
    env.deps.config.mode = 'serverless';
    expect((await refreshPresence(env.deps, [alice.agentId]))[0]?.presence).toBe('away');
    env.deps.config.mode = 'server';
  });

  it('ingest is live only as a fallback: for sessions whose listener does not report turns, until the session ends', async () => {
    await env.db.query(
      `insert into public.sessions (agent_id, harness_session_id, last_event_at) values ($1, 's-a', now() - interval '1 minute')`,
      [alice.agentId],
    );
    // An older plugin's listener (no turn reports): the recent ingest makes it live.
    await env.db.query(
      `insert into public.session_leases (agent_id, session_id, listening, last_heartbeat_at) values ($1, 's-a', 'listening', now())`,
      [alice.agentId],
    );
    expect((await refreshPresence(env.deps, [alice.agentId]))[0]?.presence).toBe('live');
    await env.db.query(`update public.sessions set last_event_at = now() - interval '11 minutes'`);
    expect((await refreshPresence(env.deps, [alice.agentId]))[0]?.presence).toBe('listening');

    // A listener that reports turns and says idle: a fresh ingest (sent at the END of a turn) is not live.
    await env.db.query(`update public.sessions set last_event_at = now()`);
    await env.db.query(`update public.session_leases set reports_turns = true, active_at = null`);
    expect(await refreshPresence(env.deps, [alice.agentId])).toEqual([]);
    expect(await stored(alice.agentId)).toBe('listening');

    // An ended session is never live, however recent.
    await env.db.query(`update public.session_leases set reports_turns = false, last_heartbeat_at = now() - interval '1 hour'`);
    await env.db.query(`update public.sessions set last_event_at = now(), status = 'closed', ended_at = now(), close_reason = 'session_end'`);
    expect((await refreshPresence(env.deps, [alice.agentId]))[0]?.presence).toBe('away');
    expect(await stored(alice.agentId)).toBe('away');
  });

  it('publishes one ids-only event per change to the owner and teammates, none when unchanged', async () => {
    await env.db.query(`insert into public.sessions (agent_id, harness_session_id) values ($1, 's-a')`, [alice.agentId]);
    await refreshPresence(env.deps, [alice.agentId]);
    await refreshPresence(env.deps, [alice.agentId]);
    const evs = presenceEvents();
    expect(evs).toHaveLength(1);
    const ev = evs[0]!;
    expect(ev.audienceAgentIds).toEqual([]);
    expect(new Set(ev.audienceUserIds)).toEqual(new Set([alice.userId, bob.userId]));
    expect(ev.audienceUserIds).not.toContain(carol.userId);
    expect(StreamEvent.parse({ type: ev.type, ...ev.payload })).toEqual({ type: 'presence', agentId: alice.agentId, presence: 'live' });
  });

  it('the pulse heartbeat makes the agent listening with exactly one event, and none on the next poll', async () => {
    expect((await pulse(B, 's-b')).status).toBe(200);
    expect(await stored(bob.agentId)).toBe('listening');
    expect(presenceEvents()).toHaveLength(1);
    expect(presenceEvents()[0]!.payload).toEqual({ agentId: bob.agentId, presence: 'listening' });
    expect((await pulse(B, 's-b')).status).toBe(200);
    expect(presenceEvents()).toHaveLength(1);
    // A stranger polling is listening too, but only its own team hears about it.
    expect((await pulse(C, 's-c')).status).toBe(200);
    expect(presenceEvents()[1]!.audienceUserIds).toEqual([carol.userId]);
  });

  it('pulse turn reports: active=1 is live at once, active=0 drops to listening, omitted leaves the turn state alone', async () => {
    expect((await pulse(B, 's-b', '1')).status).toBe(200);
    expect(await stored(bob.agentId)).toBe('live');
    // An in-flight poll from an older listener (no `active`) does not end the turn.
    expect((await pulse(B, 's-b')).status).toBe(200);
    expect(await stored(bob.agentId)).toBe('live');
    const lease = await env.db.query<{ reports_turns: boolean; active: boolean }>(
      `select reports_turns, active_at is not null as active from public.session_leases where agent_id = $1`,
      [bob.agentId],
    );
    expect(lease.rows[0]).toEqual({ reports_turns: true, active: true });
    expect((await pulse(B, 's-b', '0')).status).toBe(200);
    expect(await stored(bob.agentId)).toBe('listening');
    expect(presenceEvents().map((e) => e.payload.presence)).toEqual(['live', 'listening']);
    // The Stop-hook ingest that follows a turn does not make a turn-reporting session live again.
    expect(
      (
        await env.app.request('/api/v1/ingest', {
          method: 'POST',
          headers: { authorization: B, 'content-type': 'application/json' },
          body: JSON.stringify(fx.ingestChunk({ sessionId: 's-b', seq: 0 })),
        })
      ).status,
    ).toBe(200);
    expect(await stored(bob.agentId)).toBe('listening');
    const bad = await env.app.request('/api/v1/pulse?wait=0&sessionId=s-b&active=yes', { headers: { authorization: B, 'x-y-session': 's-b' } });
    expect(bad.status).toBe(400);
  });

  it('ingest (no turn reports) makes the agent live; a session-end chunk ends the session, clears its lease, and the agent goes away', async () => {
    const send = (seq: number, close?: { reason: 'session_end' }) =>
      env.app.request('/api/v1/ingest', {
        method: 'POST',
        headers: { authorization: A, 'content-type': 'application/json' },
        body: JSON.stringify(fx.ingestChunk({ sessionId: 's-ingest', seq, ...(close ? { close } : {}) })),
      });
    expect((await send(0)).status).toBe(200);
    expect(await stored(alice.agentId)).toBe('live');
    expect(presenceEvents().map((e) => e.payload.presence)).toEqual(['live']);

    // Its listener (an older plugin: no turn reports) is heartbeating.
    expect((await pulse(A, 's-ingest')).status).toBe(200);
    await env.db.query('delete from public.rate_buckets'); // ingest allows 1 chunk / 5 s per session
    const closed = await send(2, { reason: 'session_end' });
    expect(closed.status).toBe(200);
    const session = async () =>
      (
        await env.db.query<{ status: string; close_reason: string | null; ended: boolean }>(
          `select status, close_reason, ended_at is not null as ended from public.sessions where harness_session_id = 's-ingest'`,
        )
      ).rows[0];
    expect(await session()).toEqual({ status: 'closed', close_reason: 'session_end', ended: true });
    const lease = await env.db.query<{ listening: string }>(
      `select listening::text as listening from public.session_leases where agent_id = $1 and session_id = 's-ingest'`,
      [alice.agentId],
    );
    expect(lease.rows[0]?.listening).toBe('none');
    expect(await stored(alice.agentId)).toBe('away');
    expect(presenceEvents().map((e) => e.payload.presence)).toEqual(['live', 'away']);

    // A resend of the session-end chunk (its response was lost) and a late, older chunk don't reopen it.
    await env.db.query('delete from public.rate_buckets');
    expect(await (await send(2, { reason: 'session_end' })).json()).toMatchObject({ duplicate: true });
    expect(await session()).toEqual({ status: 'closed', close_reason: 'session_end', ended: true });
    await env.db.query('delete from public.rate_buckets');
    expect(await (await send(1)).json()).toMatchObject({ accepted: true });
    expect(await session()).toEqual({ status: 'closed', close_reason: 'session_end', ended: true });
    expect(await stored(alice.agentId)).toBe('away');

    // A resumed session's next (newer) chunk reopens it.
    await env.db.query('delete from public.rate_buckets');
    expect((await send(3)).status).toBe(200);
    expect(await session()).toEqual({ status: 'open', close_reason: null, ended: false });
    expect(await stored(alice.agentId)).toBe('live');
  });

  it('the presence_sweep job decays stale agents, promotes fresh ones, and re-arms itself', async () => {
    await env.db.query(`update public.agent_presence set presence = 'live' where agent_id = $1`, [alice.agentId]);
    await env.db.query(
      `insert into public.session_leases (agent_id, session_id, listening, last_heartbeat_at) values ($1, 's-b', 'listening', now())`,
      [bob.agentId],
    );
    const enqueued: { topic: string; opts: unknown }[] = [];
    const realEnqueue = env.deps.jobs.enqueue.bind(env.deps.jobs);
    env.deps.jobs.enqueue = async (topic, payload, opts) => { enqueued.push({ topic, opts }); };
    try {
      await PLATFORM_JOBS.presence_sweep!({}, env.deps);
    } finally {
      env.deps.jobs.enqueue = realEnqueue;
    }
    // It re-armed itself for 5 s before a coming minute boundary (deduped per slot), so the cron
    // tick at that boundary already sees it due.
    expect(enqueued).toEqual([{ topic: 'presence_sweep', opts: expect.objectContaining({ dedupeKey: expect.stringMatching(/^presence_sweep:\d+$/) }) }]);
    const opts = enqueued[0]!.opts as { runAfterMs: number; dedupeKey: string };
    const slot = Number(opts.dedupeKey.split(':')[1]);
    expect(opts.runAfterMs).toBeGreaterThan(0);
    expect(opts.runAfterMs).toBeLessThanOrEqual(90_000);
    expect(Math.abs(env.deps.now().getTime() + opts.runAfterMs - (slot * 60_000 - 5_000))).toBeLessThan(2_000);
    expect(await stored(alice.agentId)).toBe('away');
    expect(await stored(bob.agentId)).toBe('listening');
    expect(presenceEvents().map((e) => e.payload)).toEqual(
      expect.arrayContaining([{ agentId: alice.agentId, presence: 'away' }, { agentId: bob.agentId, presence: 'listening' }]),
    );
    expect(presenceEvents()).toHaveLength(2);
    // Nothing changed: the next sweep is silent.
    await refreshPresence(env.deps, null);
    expect(presenceEvents()).toHaveLength(2);
  });

  it('status, /me and agent refs read the refreshed value; refs show presence only to the owner and teammates', async () => {
    expect((await pulse(A, 's-a')).status).toBe(200);
    const s = await callTool(env, 'status', B, {});
    expect(s.body.output.teammates).toEqual(expect.arrayContaining([expect.objectContaining({ handle: alice.agentHandle, presence: 'listening' })]));
    expect((await callTool(env, 'status', A, {})).body.output.agent.presence).toBe('listening');

    const web = env.token('alice-web', webCaller(alice));
    const me = Me.parse(await (await env.app.request('/api/v1/me', { headers: { authorization: web } })).json());
    expect(me.agents.find((a) => a.id === alice.agentId)?.presence).toBe('listening');

    const asBob = await env.db.asUser(webCaller(bob).claims, (tx) => loadAgentRefs(tx, [alice.agentId]));
    expect(asBob.get(alice.agentId)?.presence).toBe('listening');
    const asCarol = await env.db.asUser(webCaller(carol).claims, (tx) => loadAgentRefs(tx, [alice.agentId]));
    expect(asCarol.get(alice.agentId)?.presence).toBeUndefined(); // a stranger (RLS hides even the agent here)
    // With a public profile carol can see alice's agent, but she is not a teammate: still no presence.
    await env.db.query('update public.users set public_profile = true where id = $1', [alice.userId]);
    try {
      const asCarolPublic = await env.db.asUser(webCaller(carol).claims, (tx) => loadAgentRefs(tx, [alice.agentId]));
      expect(asCarolPublic.get(alice.agentId)).toBeDefined();
      expect(asCarolPublic.get(alice.agentId)?.presence).toBeUndefined();
    } finally {
      await env.db.query('update public.users set public_profile = false where id = $1', [alice.userId]);
    }
    // Service-role reads decide by the viewer passed in; without one they carry no presence.
    expect((await env.db.asService((tx) => loadAgentRefs(tx, [alice.agentId], bob.userId))).get(alice.agentId)?.presence).toBe('listening');
    expect((await env.db.asService((tx) => loadAgentRefs(tx, [alice.agentId], carol.userId))).get(alice.agentId)?.presence).toBeUndefined();
    expect((await env.db.asService((tx) => loadAgentRefs(tx, [alice.agentId]))).get(alice.agentId)?.presence).toBeUndefined();
  });
});
