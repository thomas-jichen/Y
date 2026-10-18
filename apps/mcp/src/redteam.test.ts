/**
 * Red-team regressions for the forwarder: every core call carries a fresh
 * signed nonce (core's replay guard, #73), and a signed-out caller's network
 * address reaches core only as a hash (the anonymous rate-limit key, #18),
 * taken from the hop the nearest proxy appended, not a client-chosen one.
 */
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InternalMcpMeta, type StatusOutput } from '@y/schema';
import { createServer } from './app.js';
import { createCoreClient } from './core-client.js';
import { clientAddressFrom, clientKeyFor, runTool } from './tools.js';

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
    const r = await runTool(core, 'status', {}, { clientAddress: '203.0.113.7' });
    expect(r.isError).toBeFalsy();
    const meta = InternalMcpMeta.parse(JSON.parse(bodies[0]!).meta);
    expect(meta.clientKey).toBe(clientKeyFor('203.0.113.7'));
    expect(meta.clientKey).toMatch(/^[a-f0-9]{32}$/);
    expect(bodies[0]).not.toContain('203.0.113.7');
    expect(clientKeyFor(undefined)).toBeUndefined();
    expect(clientKeyFor('x'.repeat(200))).toBeUndefined();
  });
});

describe('client address for signed-out limits', () => {
  it('uses the rightmost X-Forwarded-For hop, or a named trusted header', () => {
    const h = (m: Record<string, string>) => (n: string) => m[n];
    expect(clientAddressFrom(h({ 'x-forwarded-for': 'spoof-1, 198.51.100.9' }))).toBe('198.51.100.9');
    expect(clientAddressFrom(h({ 'x-forwarded-for': '198.51.100.9' }))).toBe('198.51.100.9');
    expect(clientAddressFrom(h({ 'x-real-ip': '203.0.113.1' }))).toBeUndefined();
    expect(clientAddressFrom(h({ 'x-forwarded-for': 'spoof', 'fly-client-ip': '192.0.2.4' }), 'Fly-Client-IP')).toBe('192.0.2.4');
    expect(clientAddressFrom(h({}))).toBeUndefined();
  });

  describe('through createServer', () => {
    let fake: Server;
    let url = '';
    const metas: unknown[] = [];
    beforeAll(async () => {
      fake = createHttpServer((req, res) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (c: string) => (raw += c));
        req.on('end', () => {
          metas.push(JSON.parse(raw || '{}').meta);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, output: statusOut }));
        });
      });
      await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    });
    afterAll(async () => { await new Promise<void>((resolve) => fake.close(() => resolve())); });

    async function callStatus(server: ReturnType<typeof createServer>, headers: Record<string, string>) {
      const res = await server.fetch(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }),
      }));
      await res.text();
      return InternalMcpMeta.parse(metas[metas.length - 1]);
    }

    it('a client rotating its own X-Forwarded-For entries keeps one key', async () => {
      const server = createServer({ logging: false, core: { coreUrl: url, internalSecret: 'test-internal-secret-0123456789', webUrl: 'http://localhost:5173' } });
      const a = await callStatus(server, { 'x-forwarded-for': '10.9.9.1, 198.51.100.9' });
      const b = await callStatus(server, { 'x-forwarded-for': '10.9.9.2, 198.51.100.9', 'x-real-ip': '10.9.9.3' });
      expect(a.clientKey).toBe(clientKeyFor('198.51.100.9'));
      expect(b.clientKey).toBe(a.clientKey);
    });

    it('honours a configured trusted header', async () => {
      const server = createServer({ logging: false, clientIpHeader: 'fly-client-ip', core: { coreUrl: url, internalSecret: 'test-internal-secret-0123456789', webUrl: 'http://localhost:5173' } });
      const m = await callStatus(server, { 'x-forwarded-for': '198.51.100.9', 'fly-client-ip': '192.0.2.4' });
      expect(m.clientKey).toBe(clientKeyFor('192.0.2.4'));
    });
  });
});
