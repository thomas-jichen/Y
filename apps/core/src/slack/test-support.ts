/**
 * Slack test harness: makeEnv (messaging test-support) with platform,
 * messaging, internal-mcp and a Slack module on a FakeSlackClient, a real
 * PgJobQueue (the 9005 trigger inserts into public.jobs directly), a
 * mutable clock, and helpers to sign Slack requests. No network.
 */
import type { CoreModule } from '../contracts.js';
import { internalMcpModule } from '../internal-mcp/index.js';
import { messagingModule } from '../messaging/index.js';
import { agentCaller, callTool, makeEnv, seedPerson, webCaller, type Person, type TestEnv } from '../messaging/test-support.js';
import { PgJobQueue, migrateCore, platformModule } from '../platform/index.js';
import { FakeSlackClient } from './fake-client.js';
import { createSlackModule } from './index.js';
import { signSlackRequest } from './verify.js';

export const SIGNING_SECRET = 'test-signing-secret-0000000000000000';
export const BOT_TOKEN = 'xoxb-test-0000';
export const TEAM = 'T0TEST001';
export const WEB = 'https://web.test';

export interface SlackEnv {
  env: TestEnv;
  fake: FakeSlackClient;
  queue: PgJobQueue;
  drain(): Promise<number>;
  advance(ms: number): void;
  now(): Date;
  /** POST a signed Slack request. */
  signed(path: string, rawBody: string, contentType: string, opts?: { ts?: number; secret?: string }): Promise<Response>;
  command(user: string, text: string, opts?: { channel?: string; team?: string; userName?: string }): Promise<any>;
  action(user: string, actionId: string, value: string, opts?: { channel?: string; ts?: string; actionTs?: string }): Promise<Response>;
  event(e: Record<string, unknown>, opts?: { eventId?: string; team?: string }): Promise<Response>;
  web(p: Person, opts?: { authTime?: number | null }): string;
  agent(p: Person): string;
  /** Link a Slack user to a Y person via /y connect + POST /api/v1/slack/link. */
  link(p: Person, slackUser: string): Promise<void>;
}

let seq = 0;

export async function makeSlackEnv(opts: { enabled?: boolean; modules?: CoreModule[] } = {}): Promise<SlackEnv> {
  const fake = new FakeSlackClient();
  const slack = createSlackModule({ client: fake });
  const modules = [platformModule, messagingModule, internalMcpModule, slack, ...(opts.modules ?? [])];
  const env = await makeEnv(modules);
  await migrateCore(env.db);
  if (opts.enabled !== false) env.deps.config.slack = { signingSecret: SIGNING_SECRET, botToken: BOT_TOKEN, teamId: TEAM, webUrl: WEB };
  let t = Date.parse('2026-01-01T00:00:00Z');
  env.deps.now = () => new Date(t);
  const handlers = Object.assign({}, ...modules.map((m) => m.jobs));
  const queue = new PgJobQueue(env.db, handlers, env.deps.now);
  queue.bind(env.deps);
  env.deps.jobs = queue;

  const signed = async (path: string, rawBody: string, contentType: string, o: { ts?: number; secret?: string } = {}): Promise<Response> => {
    const ts = o.ts ?? Math.floor(t / 1000);
    return env.app.request(path, {
      method: 'POST',
      headers: { 'content-type': contentType, ...signSlackRequest(o.secret ?? SIGNING_SECRET, rawBody, ts) },
      body: rawBody,
    });
  };
  const s: SlackEnv = {
    env, fake, queue,
    drain: async () => { let n = 0; for (let i = 0; i < 10; i++) { const k = await queue.drain(50); n += k; if (!k) break; } return n; },
    advance: (ms) => { t += ms; },
    now: () => new Date(t),
    signed,
    async command(user, text, o = {}) {
      const form = new URLSearchParams({ team_id: o.team ?? TEAM, user_id: user, channel_id: o.channel ?? 'C0FEED001', command: '/y', text, ...(o.userName ? { user_name: o.userName } : {}) });
      const res = await signed('/slack/commands', form.toString(), 'application/x-www-form-urlencoded');
      return res.json();
    },
    async action(user, actionId, value, o = {}) {
      const payload = {
        type: 'block_actions', user: { id: user }, team: { id: TEAM },
        container: { channel_id: o.channel ?? 'D0CHAN001', message_ts: o.ts ?? '1700000000.000001' },
        actions: [{ action_id: actionId, value, action_ts: o.actionTs ?? `1700000100.${String(++seq).padStart(6, '0')}` }],
      };
      return signed('/slack/interactivity', new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), 'application/x-www-form-urlencoded');
    },
    async event(e, o = {}) {
      const body = { type: 'event_callback', team_id: o.team ?? TEAM, event_id: o.eventId ?? `Ev${String(++seq).padStart(8, '0')}`, event: e };
      return signed('/slack/events', JSON.stringify(body), 'application/json');
    },
    // A fresh login (step-up passes) unless the test says otherwise.
    web: (p, o = {}) => env.token(`${p.handle}-web${o.authTime === undefined ? '' : `-${o.authTime}`}`, { ...webCaller(p), authTime: o.authTime === undefined ? Math.floor(t / 1000) : o.authTime }),
    agent: (p) => env.token(`${p.handle}-agent`, agentCaller(p)),
    async link(p, slackUser) {
      const r = await s.command(slackUser, 'connect');
      const url = r.blocks[1].elements[0].url as string;
      const token = new URL(url).searchParams.get('token');
      const res = await env.app.request('/api/v1/slack/link', {
        method: 'POST', headers: { authorization: s.web(p), 'content-type': 'application/json' }, body: JSON.stringify({ token }),
      });
      if (res.status !== 200) throw new Error(`link failed: ${res.status} ${await res.text()}`);
    },
  };
  return s;
}

/** Synthetic Slack user ids. */
export const SU = { alice: 'U0ALICE01', bob: 'U0BOB0001', carol: 'U0CAROL01', eve: 'U0EVE0001' };

export { callTool, seedPerson };
export type { Person };

/** Every string in a Slack payload, for "no unescaped <!" style assertions. */
export function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => allStrings(x, out));
  return out;
}
