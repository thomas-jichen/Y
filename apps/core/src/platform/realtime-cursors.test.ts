/**
 * Red-team regressions for the push paths (webapi cluster): commit-ordered
 * event ids (#33), the serverless SSE start cursor and shared poller (#87,
 * #85), and GET /api/v1/stream replay, re-auth and per-user cap (#47, #83,
 * #85). PGlite, synthetic users, no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type PgliteDb } from '@y/db';
import type { CoreConfig, PushEvent } from '../contracts.js';
import { makeEnv, seedPerson, webCaller, type Person, type TestEnv } from '../messaging/test-support.js';
import { PgPushBus } from './bus.js';
import { migrateCore, platformModule } from './index.js';
import { STREAM_LIMITS } from './routes/web.js';
import { ServerlessPushBus } from './serverless-bus.js';

const quiet = () => undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(10);
}

const PRESENCE = JSON.stringify({ agentId: `a_${'0'.repeat(26)}`, presence: 'live' });

async function insertEvent(db: PgliteDb | TestEnv['db'], userId: string, explicitId?: number): Promise<void> {
  if (explicitId === undefined) {
    await db.query(`insert into public.events (type, audience_user_ids, payload) values ('presence', array[$1]::uuid[], $2::jsonb)`, [userId, PRESENCE]);
  } else {
    await db.query(`insert into public.events (id, type, audience_user_ids, payload) values ($2, 'presence', array[$1]::uuid[], $3::jsonb)`, [
      userId,
      explicitId,
      PRESENCE,
    ]);
  }
}

describe('event ids follow commit order (#33)', () => {
  let db: PgliteDb;
  let userId: string;
  beforeAll(async () => {
    db = await createTestDb();
    await migrateCore(db);
    userId = (await seedPerson(db, 'cursor-ann')).userId;
  }, 180_000);
  afterAll(async () => {
    await db?.close();
  });

  it('an event is numbered at commit, after every id handed out while its transaction ran', async () => {
    let provisional = 0;
    let drawnMeanwhile = 0;
    await db.asService(async (tx) => {
      const ins = await tx.query<{ id: string }>(
        `insert into public.events (type, audience_user_ids, payload) values ('presence', array[$1]::uuid[], '{}') returning id`,
        [userId],
      );
      provisional = Number(ins.rows[0]!.id);
      // What a concurrent short transaction would draw (and commit) while this one is still open.
      drawnMeanwhile = Number((await tx.query<{ v: string }>(`select nextval('public.events_id_seq') as v`)).rows[0]!.v);
    });
    const committed = await db.query<{ id: string }>(`select id from public.events where audience_user_ids @> array[$1]::uuid[] order by id desc limit 1`, [userId]);
    expect(drawnMeanwhile).toBeGreaterThan(provisional);
    expect(Number(committed.rows[0]!.id)).toBeGreaterThan(drawnMeanwhile);
    // Order inside one transaction is kept.
    await db.asService(async (tx) => {
      for (const n of [1, 2, 3]) {
        await tx.query(`insert into public.events (type, audience_user_ids, payload) values ('presence', array[$1]::uuid[], $2::jsonb)`, [
          userId,
          JSON.stringify({ n }),
        ]);
      }
    });
    const ordered = await db.query<{ n: number }>(
      `select (payload->>'n')::int as n from public.events where audience_user_ids @> array[$1]::uuid[] and payload ? 'n' order by id`,
      [userId],
    );
    expect(ordered.rows.map((r) => r.n)).toEqual([1, 2, 3]);
  });

  it('the bus delivers an event whose transaction drew a lower id but committed after the watermark moved', async () => {
    const bus = new PgPushBus(db, quiet);
    await bus.start();
    try {
      const got: PushEvent[] = [];
      const unsub = bus.subscribeUser(userId, (e) => got.push(e));
      await bus.publish({ type: 'presence', audienceAgentIds: [], audienceUserIds: [userId], payload: {} });
      expect(got).toHaveLength(1);
      const watermark = Number(bus.cursor);
      // The red-team probe: a row numbered below the watermark becomes visible afterwards.
      const low = Number((await db.query<{ v: string }>(`select coalesce(min(id), 1) - 1 as v from public.events`)).rows[0]!.v);
      expect(low).toBeLessThan(watermark);
      await insertEvent(db, userId, low);
      await bus.pump();
      expect(got).toHaveLength(2);
      expect(Number(got[1]!.id)).toBeGreaterThan(watermark);
      unsub();
    } finally {
      await bus.stop();
    }
  });

  it('a pulse cursor taken before a late commit still sees that event', async () => {
    const agent = await seedPerson(db, 'cursor-bea');
    const bus = new PgPushBus(db, quiet);
    await bus.start();
    try {
      await bus.publish({ type: 'presence', audienceAgentIds: [agent.agentId], audienceUserIds: [], payload: {} });
      const first = await bus.waitForAgent(agent.agentId, '0', 10);
      const cursor = first.cursor!;
      const low = Number((await db.query<{ v: string }>(`select coalesce(min(id), 1) - 1 as v from public.events`)).rows[0]!.v);
      await db.query(`insert into public.events (id, type, audience_agent_ids, payload) values ($2, 'presence', array[$1]::uuid[], '{}')`, [agent.agentId, low]);
      const next = await bus.waitForAgent(agent.agentId, cursor, 10);
      expect(next.events).toHaveLength(1);
    } finally {
      await bus.stop();
    }
  });

  it('the Realtime REST cursor broadcasts a late-committed event', async () => {
    const sent: unknown[] = [];
    const config = {
      supabase: { url: 'https://proj.supabase.test', jwksUrl: null, serviceKey: 'service-role-key-for-tests' },
      realtimeRest: 'on',
    } as unknown as CoreConfig;
    const fetch = (async (_u: unknown, init?: RequestInit) => {
      sent.push(...(JSON.parse(String(init?.body)) as { messages: unknown[] }).messages);
      return new Response('{}', { status: 202 });
    }) as typeof globalThis.fetch;
    await db.query(`insert into public.realtime_channels (owner_kind, owner_id) values ('user', $1) on conflict do nothing`, [userId]).catch(() => undefined);
    const bus = new ServerlessPushBus(db, quiet, config, { fetch });
    await bus.start();
    await bus.flushRealtime(); // drain
    sent.length = 0;
    const low = Number((await db.query<{ v: string }>(`select coalesce(min(id), 1) - 1 as v from public.events`)).rows[0]!.v);
    await insertEvent(db, userId, low);
    const channels = Number((await db.query<{ n: number }>(`select count(*)::int as n from public.realtime_channels where owner_id = $1`, [userId])).rows[0]!.n);
    expect(await bus.flushRealtime()).toBe(channels);
    expect(channels).toBeGreaterThan(0);
  });
});

describe('serverless SSE subscriptions (#87, #85)', () => {
  let db: PgliteDb;
  let person: Person;
  beforeAll(async () => {
    db = await createTestDb();
    await migrateCore(db);
    person = await seedPerson(db, 'sls-cat');
  }, 180_000);
  const subs: Array<() => void> = [];
  afterEach(() => {
    for (const u of subs.splice(0)) u();
  });
  afterAll(async () => {
    await db?.close();
  });
  const track = <T extends () => void>(u: T): T => {
    subs.push(u);
    return u;
  };

  const bus = () => new ServerlessPushBus(db, quiet, { supabase: { url: null, jwksUrl: null, serviceKey: null } } as unknown as CoreConfig, { pollMs: 20 });

  it('a new subscriber gets only events after it subscribed, not everything since the instance started', async () => {
    const b = bus();
    await b.start();
    await insertEvent(db, person.userId); // after cold start, before the stream opens
    const got: PushEvent[] = [];
    const unsub = track(b.subscribeUser(person.userId, (e) => got.push(e)));
    await (unsub as { ready?: Promise<void> }).ready;
    await sleep(120);
    expect(got).toEqual([]);
    await insertEvent(db, person.userId);
    await until(() => got.length > 0);
    expect(got).toHaveLength(1);
    unsub();
  });

  it("shares one poller across a user's streams and stops it with the last one", async () => {
    const b = bus();
    await b.start();
    const a: PushEvent[] = [];
    const c: PushEvent[] = [];
    const ua = track(b.subscribeUser(person.userId, (e) => a.push(e)));
    const uc = track(b.subscribeUser(person.userId, (e) => c.push(e)));
    await (ua as { ready?: Promise<void> }).ready;
    await (uc as { ready?: Promise<void> }).ready;
    expect(b.userPollerCount).toBe(1);
    await insertEvent(db, person.userId);
    await until(() => a.length > 0 && c.length > 0);
    await sleep(60);
    expect([a.length, c.length]).toEqual([1, 1]);
    // A stream that joins later starts where the poller is: it does not get the earlier event.
    const late: PushEvent[] = [];
    const ul = track(b.subscribeUser(person.userId, (e) => late.push(e)));
    await sleep(60);
    expect(late).toEqual([]);
    ua();
    uc();
    ul();
    expect(b.userPollerCount).toBe(0);
  });
});

describe('GET /api/v1/stream (#47, #83, #85)', () => {
  let env: TestEnv;
  let dan: Person;
  let auth: string;
  const pushers: Array<(e: PushEvent) => void> = [];
  const saved = { ...STREAM_LIMITS };

  beforeAll(async () => {
    env = await makeEnv([platformModule]);
    await migrateCore(env.db);
    dan = await seedPerson(env.db, 'stream-dan');
    auth = env.token('dan-web', webCaller(dan));
    const memory = env.deps.bus;
    env.deps.bus = {
      publish: (e, tx) => memory.publish(e, tx),
      waitForAgent: (a, c, t) => memory.waitForAgent(a, c, t),
      subscribeUser: (_u, cb) => {
        pushers.push(cb);
        return () => {
          const i = pushers.indexOf(cb);
          if (i >= 0) pushers.splice(i, 1);
        };
      },
    };
  }, 180_000);
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    Object.assign(STREAM_LIMITS, saved);
    for (const close of closers.splice(0)) await close();
  });
  afterAll(async () => {
    await env?.db.close();
  });

  async function open(headers: Record<string, string> = {}) {
    const ac = new AbortController();
    const res = await env.app.request('/api/v1/stream', { headers: { authorization: auth, ...headers }, signal: ac.signal });
    let text = '';
    let done = false;
    const reader = res.status === 200 ? res.body!.getReader() : null;
    const pump = (async () => {
      if (!reader) return;
      for (;;) {
        const r = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (r.done) break;
        text += new TextDecoder().decode(r.value);
      }
      done = true;
    })();
    const close = async () => {
      ac.abort();
      await reader?.cancel().catch(() => undefined);
      await pump;
    };
    closers.push(close);
    return { res, text: () => text, done: () => done, close };
  }

  const ids = (text: string) => [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));

  it('replays every missed event, oldest first, across pages', async () => {
    const base = Number((await env.db.query<{ v: string }>(`select coalesce(max(id), 0) as v from public.events`)).rows[0]!.v);
    for (let i = 0; i < 3; i++) await insertEvent(env.db, dan.userId);
    const s = await open({ 'last-event-id': String(base) });
    await until(() => ids(s.text()).length >= 3);
    const got = ids(s.text());
    expect(got).toHaveLength(3);
    expect([...got].sort((x, y) => x - y)).toEqual(got);
    await s.close();

    const base2 = Number((await env.db.query<{ v: string }>(`select coalesce(max(id), 0) as v from public.events`)).rows[0]!.v);
    await env.db.query(
      `insert into public.events (type, audience_user_ids, payload) select 'presence', array[$1]::uuid[], $2::jsonb from generate_series(1, 150)`,
      [dan.userId, PRESENCE],
    );
    const s2 = await open({ 'last-event-id': String(base2) });
    await until(() => ids(s2.text()).length >= 150, 5_000);
    expect(new Set(ids(s2.text())).size).toBe(150);
    await s2.close();
  });

  it('ends the stream once its bearer is no longer valid', async () => {
    STREAM_LIMITS.reauthMs = 0;
    const tmp = env.token('dan-web-tmp', webCaller(dan));
    const ac = new AbortController();
    const res = await env.app.request('/api/v1/stream', { headers: { authorization: tmp }, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    closers.push(async () => {
      ac.abort();
      await reader.cancel().catch(() => undefined);
    });
    let text = '';
    let ended = false;
    const pump = (async () => {
      for (;;) {
        const r = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (r.done) break;
        text += new TextDecoder().decode(r.value);
      }
      ended = true;
    })();
    await until(() => text.includes(': open'));
    // Still valid: events flow.
    for (const p of [...pushers]) p({ id: '999000001', type: 'presence', audienceAgentIds: [], audienceUserIds: [dan.userId], payload: { agentId: `a_${'0'.repeat(26)}`, presence: 'live' } });
    await until(() => text.includes('id: 999000001'));
    expect(text).toContain('id: 999000001');
    env.callers.delete('dan-web-tmp'); // the session is revoked
    for (const p of [...pushers]) p({ id: '999000002', type: 'presence', audienceAgentIds: [], audienceUserIds: [dan.userId], payload: { agentId: `a_${'0'.repeat(26)}`, presence: 'live' } });
    await until(() => ended);
    const endedByServer = ended;
    ac.abort();
    await reader.cancel().catch(() => undefined);
    await pump;
    expect(endedByServer).toBe(true);
    expect(text).not.toContain('id: 999000002');
  });

  it('caps open streams per user and frees the slot when one closes', async () => {
    STREAM_LIMITS.maxPerUser = 2;
    const a = await open();
    const b = await open();
    expect([a.res.status, b.res.status]).toEqual([200, 200]);
    const c = await open();
    const status = c.res.status;
    if (status !== 429) await c.close();
    expect(status).toBe(429);
    expect(((await c.res.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    // Another user is not affected.
    const eve = await seedPerson(env.db, 'stream-eve');
    const other = await env.app.request('/api/v1/stream', { headers: { authorization: env.token('eve-web', webCaller(eve)) }, signal: AbortSignal.timeout(2_000) });
    expect(other.status).toBe(200);
    await other.body?.cancel().catch(() => undefined);
    await a.close();
    let d = await open();
    for (let i = 0; i < 50 && d.res.status !== 200; i++) {
      await sleep(20);
      d = await open();
    }
    expect(d.res.status).toBe(200);
    await b.close();
    await d.close();
  });
});
