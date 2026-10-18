/** Slack endpoints: inert without secrets, signature checks, workspace pinning, event filtering. */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@y/safety', () => import('../messaging/test-fakes.js').then((m) => m.safety));
vi.mock('@y/domain', () => import('../messaging/test-fakes.js').then((m) => m.domain));
vi.mock('@y/retrieval', () => import('../messaging/test-fakes.js').then((m) => m.retrieval));

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SlackStatus } from '@y/schema';
import { SIGNING_SECRET, SU, makeSlackEnv, seedPerson, type SlackEnv } from './test-support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let s: SlackEnv;
afterEach(async () => { await s?.env.db.close(); });

const count = async (table: string) => (await s.env.db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0]!.n;
const reply = (over: Record<string, unknown> = {}) => ({
  type: 'message', user: SU.alice, text: 'hello', ts: '1700000001.000200', thread_ts: '1700000000.000001', channel: 'D0CHAN001', channel_type: 'im', ...over,
});

describe('slack inert (no secrets)', () => {
  it('answers url_verification only, writes nothing, and jobs are no-ops', async () => {
    s = await makeSlackEnv({ enabled: false });
    const alice = await seedPerson(s.env.db, 'alice');
    const ch = await s.env.app.request('/slack/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'url_verification', challenge: 'abc123' }) });
    expect(await ch.json()).toEqual({ challenge: 'abc123' });
    const ev = await s.event(reply());
    expect(ev.status).toBe(200);
    const cmd = await s.env.app.request('/slack/commands', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'command=%2Fy&text=connect' });
    expect(await cmd.json()).toEqual({ response_type: 'ephemeral', text: 'Y is not connected to Slack yet.' });
    const act = await s.env.app.request('/slack/interactivity', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'payload=%7B%7D' });
    expect(act.status).toBe(200);
    expect(await count('slack_events_seen')).toBe(0);
    expect(await count('slack_link_tokens')).toBe(0);
    expect(await count('jobs')).toBe(0);
    // Jobs complete without Slack calls.
    await s.queue.enqueue('slack.notify_review', { reviewId: '01HZZZZZZZZZZZZZZZZZZZZZZZ' });
    await s.queue.enqueue('slack.welcome', { userId: alice.userId });
    await s.drain();
    expect((await s.env.db.query(`select state from public.jobs`)).rows.every((r: any) => r.state === 'done')).toBe(true);
    expect(s.fake.calls).toEqual([]);
    const st = SlackStatus.parse(await (await s.env.app.request('/api/v1/slack/status', { headers: { authorization: s.web(alice) } })).json());
    expect(st.available).toBe(false);
  });
});

describe('slack routes', () => {
  it('rejects bad signatures and answers a signed url_verification', async () => {
    s = await makeSlackEnv();
    const body = JSON.stringify({ type: 'url_verification', challenge: 'xyz' });
    expect((await s.env.app.request('/slack/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(401);
    expect((await s.signed('/slack/events', body, 'application/json', { secret: 'wrong-secret-00000000000000000000' })).status).toBe(401);
    expect((await s.signed('/slack/events', body, 'application/json', { ts: Math.floor(s.now().getTime() / 1000) - 600 })).status).toBe(401);
    expect((await s.signed('/slack/commands', 'command=%2Fy', 'application/x-www-form-urlencoded', { secret: 'nope-000000000000000000000000000' })).status).toBe(401);
    expect((await s.signed('/slack/interactivity', 'payload=%7B%7D', 'application/x-www-form-urlencoded', { secret: 'nope-000000000000000000000000000' })).status).toBe(401);
    const ok = await s.signed('/slack/events', body, 'application/json');
    expect(await ok.json()).toEqual({ challenge: 'xyz' });
    expect(SIGNING_SECRET).toHaveLength(36);
  });

  it('ignores other workspaces and filters events before queueing', async () => {
    s = await makeSlackEnv();
    expect((await s.event(reply(), { team: 'T0OTHER01' })).status).toBe(200);
    expect(await count('slack_events_seen')).toBe(0);
    const cmd = await s.command(SU.alice, 'connect', { team: 'T0OTHER01' });
    expect(cmd.text).toBe('This workspace is not connected to Y.');
    expect(await count('slack_link_tokens')).toBe(0);

    // Bots, apps, subtypes, edits, top-level messages and the bot itself: no job (I11).
    for (const bad of [
      reply({ bot_id: 'B0BOT0001' }), reply({ app_id: 'A0APP0001' }), reply({ subtype: 'message_changed' }), reply({ edited: { user: SU.alice, ts: '1' } }),
      reply({ thread_ts: undefined }), reply({ thread_ts: '1700000001.000200' }), reply({ user: 'U0BOT0001' }), reply({ text: '   ' }), reply({ channel_type: 'mpim' }),
    ]) {
      expect((await s.event(bad)).status).toBe(200);
    }
    expect(await count('slack_events_seen')).toBe(0);
    expect((await s.env.db.query(`select count(*)::int as n from public.jobs where topic = 'slack.event'`)).rows[0]).toEqual({ n: 0 });

    // A plain thread reply queues one job; a retry of the same event id does not.
    await s.event(reply(), { eventId: 'Ev0RETRY01' });
    await s.event(reply(), { eventId: 'Ev0RETRY01' });
    expect((await s.env.db.query(`select count(*)::int as n from public.jobs where topic = 'slack.event'`)).rows[0]).toEqual({ n: 1 });
  });

  it('9005 keeps the RLS safety net: every table has RLS and the new ones are service-only (I7)', async () => {
    s = await makeSlackEnv();
    const alice = await seedPerson(s.env.db, 'alice');
    const noRls = await s.env.db.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and n.nspname in ('public', 'y_private') and not c.relrowsecurity`);
    expect(noRls.rows).toEqual([]);
    for (const t of ['team_slack_channels', 'slack_pending_instructions', 'slack_review_posts']) {
      await expect(s.env.db.asUser({ sub: alice.userId, via: 'web' }, (tx) => tx.query(`select * from public.${t}`)), t).rejects.toThrow();
    }
  });

  it('slack code never touches dm_permissions or logs tokens', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      const src = readFileSync(dir + f, 'utf8');
      expect(src, f).not.toMatch(/dm_permissions/);
      expect(src, f).not.toMatch(/console\.(log|info|warn|error)/);
    }
  });
});
