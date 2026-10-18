/**
 * Red-team regressions for the forwarder: every core call carries a fresh
 * signed nonce (core's replay guard, #73), and a signed-out caller's network
 * address reaches core only as a hash (the anonymous rate-limit key, #18).
 */
import { describe, expect, it } from 'vitest';
import { InternalMcpMeta, type StatusOutput } from '@y/schema';
import { createCoreClient } from './core-client.js';
import { clientKeyFor, runTool } from './tools.js';

const statusOut: StatusOutput = {
  signed_in: false, token_state: null, agent: null,
  unread: { dm: 0, owner_instructions: 0, reviews: 0, suggestions: 0, posts: 0 },
  pending: { drafts: 0, change_requests: 0, approved_changes: 0 },
  next: [{ tool: 'status', reason: 'sign_in' }],
  kill_switches: { push_paths: false, network_content: false, apply: false, ingest: false },
  min_plugin_version: null, sign_in_url: 'http://localhost:5173/connect', server_time: '2026-10-17T12:00:00.000Z',
};

function fakeCore() {
  const bodies: string[] = [];
  const core = createCoreClient({
    coreUrl: 'http://core.test', internalSecret: 'test-internal-secret-0123456789', webUrl: 'http://localhost:5173',
    fetch: (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ ok: true, output: statusOut }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  return { core, bodies };
}

describe('forwarder meta', () => {
  it('sends a fresh nonce on every call (inside the signed body)', async () => {
    const { core, bodies } = fakeCore();
    await core.call('status', {});
    await core.call('status', {});
    const metas = bodies.map((b) => InternalMcpMeta.parse(JSON.parse(b).meta));
    expect(metas[0]!.nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(metas[0]!.nonce).not.toBe(metas[1]!.nonce);
  });

  it('forwards a hash of the client address, never the address', async () => {
    const { core, bodies } = fakeCore();
    const r = await runTool(core, 'status', {}, { clientAddress: '203.0.113.7, 10.0.0.1' });
    expect(r.isError).toBeFalsy();
    const meta = InternalMcpMeta.parse(JSON.parse(bodies[0]!).meta);
    expect(meta.clientKey).toBe(clientKeyFor('203.0.113.7'));
    expect(meta.clientKey).toMatch(/^[a-f0-9]{32}$/);
    expect(bodies[0]).not.toContain('203.0.113.7');
    expect(clientKeyFor(undefined)).toBeUndefined();
    expect(clientKeyFor('x'.repeat(200))).toBeUndefined();
  });
});
