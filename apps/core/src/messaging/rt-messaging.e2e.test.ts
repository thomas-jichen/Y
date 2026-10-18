/**
 * Red-team regressions on the real pipeline (unmocked @y/safety and
 * @y/domain, PGlite, no network): outbound DLP on agent-written subjects
 * (#25), and the NFKC-expanding inbox body (#1) with the real normalizer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxOutput, MessageEnvelopeContent, NewThreadResponse, decodeUntrustedContent } from '@y/schema';
import { applyMessageDecision, messagingModule } from './index.js';
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

const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const subjectOf = async (wireId: string) =>
  (await env.db.query<{ subject: string }>(`select subject from public.threads where id = $1`, [wireId.slice(2)])).rows[0]!.subject;

describe('#25 outbound DLP on agent-written subjects (real safety)', () => {
  it('does not adopt a subject carrying repo paths or an import line; the body is still delivered', async () => {
    const sent = await callTool(env, 'send_message', A, {
      to: bob.agentHandle, body: 'Here is our loader', intent: 'question', idempotency_key: key(),
      subject: "apps/billing/src/keys/master.ts import k from './internal/keys'",
    });
    expect(sent.body.output.state).toBe('delivered');
    expect(await subjectOf(sent.body.output.thread_id)).toBe('');
    const out = InboxOutput.parse((await callTool(env, 'inbox', B, {})).body.output);
    expect(out.messages).toHaveLength(1);
    expect(decodeUntrustedContent(out.messages[0]!.untrusted_content, MessageEnvelopeContent).subject).toBeUndefined();
  });

  it('still adopts a plain agent subject, and a human-written subject with a path', async () => {
    const sent = await callTool(env, 'send_message', A, {
      to: bob.agentHandle, body: 'Can you review my PR?', intent: 'question', idempotency_key: key(), subject: 'Flaky auth test',
    });
    expect(await subjectOf(sent.body.output.thread_id)).toBe('Flaky auth test');
    const res = await env.app.request('/api/v1/threads', {
      method: 'POST', headers: { authorization: Aweb, 'content-type': 'application/json' },
      body: JSON.stringify({ to: alice.agentHandle, body: 'look at this', subject: 'Fix in src/app/page.tsx' }),
    });
    expect(NewThreadResponse.parse(await res.json()).thread.subject).toBe('Fix in src/app/page.tsx');
  });
});

describe('#1 NFKC-expanding bodies (real safety)', () => {
  it('returns the message fitted to the envelope limit and marks it seen', async () => {
    const sent = await callTool(env, 'send_message', A, {
      to: bob.agentHandle, body: `${'a'.repeat(3990)}ﷺ`, intent: 'question', idempotency_key: key(),
    });
    // The real L0 may quarantine a long repetitive body; the owner's release delivers it either way.
    if (sent.body.output.state === 'quarantined') await applyMessageDecision(env.deps, sent.body.output.message_id, 'release');
    expect((await env.db.query<{ state: string }>(`select state from public.messages`)).rows[0]!.state).toBe('delivered');
    const res = await callTool(env, 'inbox', B, {});
    expect(res.body.ok).toBe(true);
    const out = InboxOutput.parse(res.body.output);
    expect(decodeUntrustedContent(out.messages[0]!.untrusted_content, MessageEnvelopeContent).body.length).toBeLessThanOrEqual(4000);
    expect((await env.db.query(`select state from public.message_deliveries`)).rows).toEqual([{ state: 'seen' }]);
  });
});
