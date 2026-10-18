/**
 * The real pipeline, unmocked: @y/safety (DLP, L0, actionFor, envelopes) and
 * @y/domain (state machine, sendPrecheck, dmDecision) on PGlite. No network:
 * routing screens with L0 only and the embedder is the hashed mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxOutput, MessageEnvelopeContent, NewThreadResponse, decodeUntrustedContent } from '@y/schema';
import { messagingModule } from './index.js';
import { internalMcpModule } from '../internal-mcp/index.js';
import { agentCaller, callTool, makeEnv, seedPerson, seedTeam, webCaller, type Person, type TestEnv } from './test-support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let env: TestEnv;
let alice: Person; let bob: Person;
let A: string; let B: string; let Aweb: string;

beforeEach(async () => {
  env = await makeEnv([messagingModule, internalMcpModule]);
  alice = await seedPerson(env.db, 'alice');
  bob = await seedPerson(env.db, 'bob');
  await seedTeam(env.db, 'acme', [alice, bob]);
  A = env.token('alice-agent', agentCaller(alice));
  B = env.token('bob-agent', agentCaller(bob));
  Aweb = env.token('alice-web', webCaller(alice));
});
afterEach(async () => { await env.db.close(); });

const send = (auth: string, to: string, body: string) =>
  callTool(env, 'send_message', auth, { to, body, intent: 'question', idempotency_key: `key-${Math.random().toString(36).slice(2, 12)}` });

describe('messaging (real safety + domain)', () => {
  it('send_message to a teammate ends delivered, opens the thread, and inbox returns an envelope', async () => {
    const sent = await send(A, bob.agentHandle, 'Did the flaky auth test fail for you too?');
    expect(sent.body.ok).toBe(true);
    expect(sent.body.output.state).toBe('delivered');
    const t = await env.db.query(`select state from public.threads where id = $1`, [sent.body.output.thread_id.replace(/^t_/, '')]);
    expect(t.rows[0]).toEqual({ state: 'open' });

    // The real sendPrecheck refuses 'request' threads for everyone, so a
    // follow-up only works because the thread opened on permission.
    const follow = await send(A, bob.agentHandle, 'It fails on CI only.');
    expect(follow.body.output.state).toBe('delivered');
    expect(follow.body.output.thread_id).toBe(sent.body.output.thread_id);

    const out = InboxOutput.parse((await callTool(env, 'inbox', B, {})).body.output);
    expect(out.messages).toHaveLength(2);
    expect(out.messages.every((m) => m.y_envelope === 'v1')).toBe(true);
    expect(out.messages.map((m) => decodeUntrustedContent(m.untrusted_content, MessageEnvelopeContent).body).sort())
      .toEqual(['Did the flaky auth test fail for you too?', 'It fails on CI only.']);
    const rows = await env.db.query(`select state from public.messages order by id`);
    expect(rows.rows).toEqual([{ state: 'delivered' }, { state: 'delivered' }]);
  });

  it('a human-started DM is delivered to the teammate agent and the agent can reply', async () => {
    const res = await env.app.request('/api/v1/threads', {
      method: 'POST', headers: { authorization: Aweb, 'content-type': 'application/json' }, body: JSON.stringify({ to: bob.agentHandle, body: 'Can you look at the deploy?' }),
    });
    expect(res.status).toBe(200);
    const out = NewThreadResponse.parse(await res.json());
    expect(out.thread.state).toBe('open');
    expect(out.messages[0]!.state).toBe('delivered');
    const inbox = InboxOutput.parse((await callTool(env, 'inbox', B, {})).body.output);
    expect(inbox.messages[0]!.from.relationship).toBe('human_comment');
    const reply = await send(B, out.thread.id, 'Looking now.');
    expect(reply.body.output.state).toBe('delivered');
  });
});
