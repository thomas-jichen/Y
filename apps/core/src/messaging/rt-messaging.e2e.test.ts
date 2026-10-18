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
let alice: Person; let bob: Person; let eve: Person;
let A: string; let B: string; let E: string; let Aweb: string; let Bweb: string;

beforeEach(async () => {
  env = await makeEnv([messagingModule, internalMcpModule]);
  alice = await seedPerson(env.db, 'alice');
  bob = await seedPerson(env.db, 'bob');
  eve = await seedPerson(env.db, 'eve');
  await seedTeam(env.db, 'acme', [alice, bob]);
  A = env.token('alice-agent', agentCaller(alice));
  B = env.token('bob-agent', agentCaller(bob));
  E = env.token('eve-agent', agentCaller(eve));
  Aweb = env.token('alice-web', webCaller(alice));
  Bweb = env.token('bob-web', webCaller(bob));
});
afterEach(async () => { await env.db.close(); });

const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const subjectOf = async (wireId: string) =>
  (await env.db.query<{ subject: string }>(`select subject from public.threads where id = $1`, [wireId.slice(2)])).rows[0]!.subject;

const PATH_SUBJECT = "apps/billing/src/keys/master.ts import k from './internal/keys'";

describe('#25 outbound DLP on agent-written subjects (real safety)', () => {
  it('does not adopt a subject carrying repo paths or an import line in a stranger DM; the body is still delivered', async () => {
    const sent = await callTool(env, 'send_message', E, {
      to: bob.agentHandle, body: 'Hi, I maintain a library you use', intent: 'question', idempotency_key: key(), subject: PATH_SUBJECT,
    });
    expect(sent.body.output.state).toBe('request_pending');
    expect(await applyMessageDecision(env.deps, sent.body.output.message_id, 'approve')).toBe('delivered');
    expect(await subjectOf(sent.body.output.thread_id)).toBe('');
    const out = InboxOutput.parse((await callTool(env, 'inbox', B, {})).body.output);
    expect(out.messages).toHaveLength(1);
    expect(decodeUntrustedContent(out.messages[0]!.untrusted_content, MessageEnvelopeContent).subject).toBeUndefined();
  });

  it('adopts a plain stranger subject, teammate subjects as before, and a human-written subject with a path', async () => {
    const st = await callTool(env, 'send_message', E, {
      to: bob.agentHandle, body: 'Hi, I maintain a library you use', intent: 'question', idempotency_key: key(), subject: 'Library question',
    });
    await applyMessageDecision(env.deps, st.body.output.message_id, 'approve');
    expect(await subjectOf(st.body.output.thread_id)).toBe('Library question');
    const sent = await callTool(env, 'send_message', A, {
      to: bob.agentHandle, body: 'Can you review my PR?', intent: 'question', idempotency_key: key(), subject: 'Bug in apps/core/src/messaging/route.ts',
    });
    expect(sent.body.output.state).toBe('delivered');
    expect(await subjectOf(sent.body.output.thread_id)).toBe('Bug in apps/core/src/messaging/route.ts');
    const res = await env.app.request('/api/v1/threads', {
      method: 'POST', headers: { authorization: Aweb, 'content-type': 'application/json' },
      body: JSON.stringify({ to: alice.agentHandle, body: 'look at this', subject: 'Fix in src/app/page.tsx' }),
    });
    expect(NewThreadResponse.parse(await res.json()).thread.subject).toBe('Fix in src/app/page.tsx');
  });
});

describe('#23 a warn-labelled comment to an allowed stranger\'s agent (real safety)', () => {
  it('is delivered with its label, as a comment always was, instead of sitting quarantined', async () => {
    // Eve opened a thread with her agent and Bob's human (no agent of Bob's in it): Bob may write to Eve's agent.
    const tid = (await env.db.query<{ id: string }>(
      `insert into public.threads (kind, requested_subject, state, created_by_user_id) values ('dm', '', 'open', $1) returning id`, [eve.userId])).rows[0]!.id;
    await env.db.query(`insert into public.thread_participants (thread_id, p_kind, p_id, role) values ($1, 'agent', $2, 'member'), ($1, 'user', $3, 'member')`,
      [tid, eve.agentId, bob.userId]);
    const res = await env.app.request(`/api/v1/threads/t_${tid}/comment`, {
      method: 'POST', headers: { authorization: Bweb, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'see https://pastebin.example/x' }),
    });
    const msg = (await res.json()) as { state: string };
    expect(res.status).toBe(200);
    expect(msg.state).toBe('delivered');
    const out = InboxOutput.parse((await callTool(env, 'inbox', E, {})).body.output);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.screen.label).toBe('warn');
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
