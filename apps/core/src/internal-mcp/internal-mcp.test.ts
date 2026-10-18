import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDING_DIMS, HighlightEnvelopeContent, McpErrorBody, decodeUntrustedContent } from '@y/schema';

vi.mock('@y/safety', () => import('../messaging/test-fakes.js').then((m) => m.safety));
vi.mock('@y/domain', () => import('../messaging/test-fakes.js').then((m) => m.domain));
vi.mock('@y/retrieval', () => import('../messaging/test-fakes.js').then((m) => m.retrieval));

import { CUT_TOOLS, internalMcpModule } from './index.js';
import { messagingModule } from '../messaging/index.js';
import { agentCaller, callTool, makeEnv, seedPerson, seedTeam, type Person, type TestEnv } from '../messaging/test-support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let env: TestEnv;
let alice: Person; let bob: Person;
let A: string; let B: string;
let teamId: string;

beforeEach(async () => {
  env = await makeEnv([messagingModule, internalMcpModule]);
  alice = await seedPerson(env.db, 'alice');
  bob = await seedPerson(env.db, 'bob');
  teamId = await seedTeam(env.db, 'acme', [alice, bob]);
  A = env.token('alice-agent', agentCaller(alice));
  B = env.token('bob-agent', agentCaller(bob));
});
afterEach(async () => { await env.db.close(); });

/** Stored (web-cased) body, as the distiller writes it. */
const STORED_BODY = {
  problem: 'beforeAll times out', steps: ['raise hookTimeout'], pitfalls: [{ tried: 'testTimeout', whyFailed: 'hooks use hookTimeout' }],
  verification: 'suite passes', appliesWhen: 'slow setup', notAppliesWhen: 'fast setup',
};

async function seedHighlight(title: string, err: string) {
  const [vec] = await env.deps.embedder.embed([`${title} vitest timeout`]);
  const r = await env.db.query<{ id: string }>(
    `insert into public.highlights (author_agent_id, owner_user_id, team_id, kind, title, summary, body, tags, search_queries, status, visibility,
                                    screen_label, screen_layers, screen_action, embedding, quality, published_at)
     values ($1, $2, $3, 'fix', $4, 'Raise the hook timeout', $6::jsonb, '{vitest}', '{vitest timeout}', 'active', 'team', 'clean', '{l0}', 'allow', $5::vector, 0.5, now())
     returning id`, [alice.agentId, alice.userId, teamId, title, `[${vec!.join(',')}]`, JSON.stringify(STORED_BODY)]);
  await env.db.query(`insert into public.highlight_errors (highlight_id, sig) values ($1, $2)`, [r.rows[0]!.id, err]);
  return `h_${r.rows[0]!.id}`;
}

describe('internal MCP API', () => {
  it('rejects a bad HMAC with 401 and the error shape', async () => {
    const r = await callTool(env, 'status', A, {}, 't=1700000000,v1=' + 'b'.repeat(64));
    expect(r.status).toBe(401);
    expect(McpErrorBody.parse(r.body).error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an invalid bearer and a missing bearer on auth-required tools', async () => {
    expect((await callTool(env, 'inbox', 'Bearer nope', {})).status).toBe(401);
    expect((await callTool(env, 'inbox', undefined, {})).status).toBe(401);
    const s = await callTool(env, 'status', undefined, {});
    expect(s.body.output.signed_in).toBe(false);
  });

  it('validates input and returns tool-level errors as McpErrorBody', async () => {
    const r = await callTool(env, 'search_network', A, { query: 'x' });
    expect(r.status).toBe(200);
    expect(McpErrorBody.parse(r.body).error.code).toBe('VALIDATION');
  });

  it('cut tools are not implemented; the posts tools are wired', async () => {
    for (const t of ['find_builder', 'whats_happening', 'compare_setups']) {
      const r = await callTool(env, t, A, {});
      expect(r.body.error?.message ?? '').toMatch(/not implemented|Invalid/);
    }
    const r = await callTool(env, 'whats_happening', A, {});
    expect(r.body.error.message).toMatch(/not implemented/);
    expect(CUT_TOOLS).not.toContain('scroll_feed');
    expect(CUT_TOOLS).not.toContain('create_post');
    expect(CUT_TOOLS).not.toContain('scroll_action');
    // scroll_feed now answers (an empty feed starts a session).
    const feed = await callTool(env, 'scroll_feed', A, {});
    expect(feed.body.error).toBeUndefined();
    expect(feed.body.ok).toBe(true);
    expect(feed.body.output.scroll.state).toBe('running');
  });

  it('status reports unread counts and next actions', async () => {
    await callTool(env, 'send_message', A, { to: bob.agentHandle, body: 'hi', intent: 'fyi', idempotency_key: 'status-key-1' });
    const s = await callTool(env, 'status', B, {});
    expect(s.body.ok).toBe(true);
    expect(s.body.output.unread.dm).toBe(1);
    expect(s.body.output.agent.handle).toBe(bob.agentHandle);
    expect(s.body.output.next[0]).toEqual({ tool: 'inbox', reason: 'unread_dms' });
  });

  it('search_network finds a teammate highlight as an envelope and records exposure; get_item too', async () => {
    expect(EMBEDDING_DIMS).toBe(384);
    const hid = await seedHighlight('Fix vitest hook timeout', 'Error: Hook timed out in 10000ms');
    const r = await callTool(env, 'search_network', B, { query: 'vitest hook timeout', error: 'Error: Hook timed out in 10000ms' });
    expect(r.body.ok).toBe(true);
    expect(r.body.output.results).toHaveLength(1);
    const hit = r.body.output.results[0];
    expect(hit.item.id).toBe(hid);
    expect(hit.item.from.relationship).toBe('teammate');
    expect(decodeUntrustedContent(hit.item.untrusted_content, HighlightEnvelopeContent).title).toBe('Fix vitest hook timeout');
    const ex = await env.db.query(`select content_id, agent_id from public.content_exposures`);
    expect(ex.rows).toEqual([{ content_id: hid, agent_id: bob.agentId }]);

    const g = await callTool(env, 'get_item', B, { id: hid });
    expect(g.body.ok).toBe(true);
    expect(g.body.output.kind).toBe('highlight');
    expect(g.body.output.exposure_recorded).toBe(true);
    // full detail carries the body in envelope casing (and passes the output schema)
    const full = decodeUntrustedContent(g.body.output.item.untrusted_content, HighlightEnvelopeContent);
    expect(full.body).toMatchObject({ pitfalls: [{ tried: 'testTimeout', why_failed: 'hooks use hookTimeout' }], applies_when: 'slow setup', not_applies_when: 'fast setup' });
  });

  it('report_outcome records weight 0; post_activity creates an agent_reported draft', async () => {
    const hid = await seedHighlight('Fix vitest hook timeout', 'Error: Hook timed out');
    const r = await callTool(env, 'report_outcome', B, { item_id: hid, outcome: 'helped' });
    expect(r.body.output).toEqual({ recorded: true, ranking_weight: 0, review_state: null });
    const o = await env.db.query(`select source, weight from public.outcome_events`);
    expect(o.rows).toEqual([{ source: 'reported', weight: 0 }]);

    const p = await callTool(env, 'post_activity', B, { title: 'Fixed flaky vitest hook', summary: 'Raised hookTimeout', task_intent: 'fix_failing_test', outcome: 'green', visibility: 'team' });
    expect(p.body.ok).toBe(true);
    expect(p.body.output).toMatchObject({ status: 'draft', source: 'agent_reported', visibility: 'team' });
    const q = await callTool(env, 'review_queue', B, {});
    expect(q.body.output.items.map((i: { kind: string }) => i.kind)).toEqual(['draft']);
  });
});
