/**
 * Round-3 red-team regressions for the internal MCP buckets:
 * - R10: many sessions and subagents on one install share the agent's
 *   'mcp' bucket, so it must hold well past 60 calls a minute;
 * - R12/R31/R35: a signed-out client key taken from the rightmost
 *   X-Forwarded-For hop (`clientKeySource: 'forwarded_for'`) may be a proxy
 *   every caller shares, so it takes the shared signed-out bucket, never a
 *   per-client one; keys from a trusted header keep their own bucket.
 * PGlite, fake safety (no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpErrorBody } from '@y/schema';

vi.mock('@y/safety', () => import('../messaging/test-fakes.js').then((m) => m.safety));
vi.mock('@y/domain', () => import('../messaging/test-fakes.js').then((m) => m.domain));
vi.mock('@y/retrieval', () => import('../messaging/test-fakes.js').then((m) => m.retrieval));

import { internalMcpModule } from './index.js';
import { MCP_BUCKET, SEARCH_BUCKET, legacySetupNames, trustedClientKeyOf } from './limits.js';
import { messagingModule } from '../messaging/index.js';
import { GOOD_HMAC, agentCaller, callTool, makeEnv, seedPerson, type Person, type TestEnv } from '../messaging/test-support.js';
import { sha256Hex } from '../platform/util.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let env: TestEnv;
let alice: Person;
let A: string;

beforeEach(async () => {
  env = await makeEnv([messagingModule, internalMcpModule]);
  alice = await seedPerson(env.db, 'alice');
  A = env.token('alice-agent', agentCaller(alice));
});
afterEach(async () => { await env.db.close(); });

async function raw(tool: string, body: unknown) {
  const res = await env.app.request(`/internal/mcp/${tool}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-y-internal': GOOD_HMAC }, body: JSON.stringify(body),
  });
  return (await res.json()) as any;
}

/** Empty the bucket `scope:<hash(parts)>` with no refill for the next hour. */
async function drain(scope: string, parts: string[]) {
  const k = `${scope}:${sha256Hex(parts.join('\n')).slice(0, 40)}`;
  await env.db.query(
    `insert into public.rate_buckets (key, tokens, updated_at) values ($1, 0, now() + interval '1 hour')
     on conflict (key) do update set tokens = 0, updated_at = now() + interval '1 hour'`, [k]);
}

describe('R10: the per-agent mcp bucket fits parallel sessions on one install', () => {
  it('allows well over 60 calls a minute from one agent token', async () => {
    expect(MCP_BUCKET.burst).toBeGreaterThanOrEqual(300);
    expect(SEARCH_BUCKET.burst).toBeGreaterThanOrEqual(300);
    // 80 calls in a burst, as from many subagents calling status / review_queue at start.
    for (let i = 0; i < 80; i++) {
      const r = await callTool(env, i % 2 ? 'status' : 'review_queue', A, {});
      expect([i, r.body.ok]).toEqual([i, true]);
    }
  });

  it('still bounds a flood: a drained agent bucket answers RATE_LIMITED', async () => {
    await drain('mcp_mcp', [`agent:${alice.agentId}`]);
    const e = McpErrorBody.parse((await callTool(env, 'status', A, {})).body).error;
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.message).toContain('300 calls per minute');
  });
});

describe('R12: signed-out keys from X-Forwarded-For are not treated as one client', () => {
  const key = 'ab'.repeat(16);
  const search = (meta: Record<string, unknown>) => raw('search_network', { input: { query: 'vitest hook timeout' }, meta });

  it('a forwarded_for key ignores a drained per-client bucket and takes the shared one', async () => {
    await drain('mcp_anon_search_network', [key]);
    // Before: every caller behind this proxy hop was RATE_LIMITED here.
    expect((await search({ clientKey: key, clientKeySource: 'forwarded_for' })).ok).toBe(true);
    await drain('mcp_anon_shared_search_network', ['none']);
    expect(McpErrorBody.parse(await search({ clientKey: key, clientKeySource: 'forwarded_for' })).error.code).toBe('RATE_LIMITED');
  });

  it('a key from a trusted header keeps its own bucket', async () => {
    await drain('mcp_anon_search_network', [key]);
    expect(McpErrorBody.parse(await search({ clientKey: key, clientKeySource: 'header' })).error.code).toBe('RATE_LIMITED');
    expect((await search({ clientKey: 'cd'.repeat(16), clientKeySource: 'header' })).ok).toBe(true);
  });

  it('trustedClientKeyOf / legacySetupNames', () => {
    expect(trustedClientKeyOf({ clientKey: key })).toBe(key);
    expect(trustedClientKeyOf({ clientKey: key, clientKeySource: 'header' })).toBe(key);
    expect(trustedClientKeyOf({ clientKey: key, clientKeySource: 'forwarded_for' })).toBeNull();
    expect(trustedClientKeyOf({ clientKey: key, clientKeySource: 'other' })).toBeNull();
    expect(legacySetupNames(undefined)).toBe(false);
    expect(legacySetupNames({ wideSetupNames: true, nonce: 'x'.repeat(32) })).toBe(false);
    expect(legacySetupNames({ client: { name: 'claude-code' } })).toBe(true);
  });
});
