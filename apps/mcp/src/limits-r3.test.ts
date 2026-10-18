/**
 * Round-3 red-team regressions for the forwarder:
 * - R12/R31/R35: a client key from the rightmost X-Forwarded-For hop is
 *   marked `clientKeySource: 'forwarded_for'` (it may be a proxy every
 *   caller shares; core then uses its shared signed-out bucket), and one
 *   from a configured Y_CLIENT_IP_HEADER is marked 'header';
 * - R11/R34: every call says it parses wide compare_setups names
 *   (`wideSetupNames`), so core keeps them only for builds that can.
 */
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InternalMcpMeta, type StatusOutput } from '@y/schema';
import { createServer } from './app.js';
import { createCoreClient } from './core-client.js';
import { clientAddressSource, clientKeyFor, runTool } from './tools.js';

const statusOut: StatusOutput = {
  signed_in: false, token_state: null, agent: null,
  unread: { dm: 0, owner_instructions: 0, reviews: 0, suggestions: 0, posts: 0 },
  pending: { drafts: 0, change_requests: 0, approved_changes: 0 },
  next: [{ tool: 'status', reason: 'sign_in' }],
  kill_switches: { push_paths: false, network_content: false, apply: false, ingest: false },
  min_plugin_version: null, sign_in_url: 'http://localhost:5173/connect', server_time: '2026-10-17T12:00:00.000Z',
};
const CORE = { internalSecret: 'test-internal-secret-0123456789', webUrl: 'http://localhost:5173' };

describe('clientAddressSource', () => {
  it("is 'header' only for a usable configured header name", () => {
    expect(clientAddressSource(undefined)).toBe('forwarded_for');
    expect(clientAddressSource('')).toBe('forwarded_for');
    expect(clientAddressSource('bad header!')).toBe('forwarded_for');
    expect(clientAddressSource('CF-Connecting-IP')).toBe('header');
  });
});

describe('forwarded meta', () => {
  it('runTool without a stated source marks the key forwarded_for; every call sends wideSetupNames', async () => {
    const bodies: string[] = [];
    const core = createCoreClient({
      coreUrl: 'http://core.test', ...CORE,
      fetch: (async (_u: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify({ ok: true, output: statusOut }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    await runTool(core, 'status', {}, { clientAddress: '203.0.113.7' });
    await runTool(core, 'status', {}, { clientAddress: '203.0.113.7', clientAddressSource: 'header' });
    await core.call('status', {});
    const raw = bodies.map((b) => JSON.parse(b).meta);
    expect(raw[0].clientKeySource).toBe('forwarded_for');
    expect(raw[1].clientKeySource).toBe('header');
    expect(raw[2].clientKeySource).toBeUndefined();
    for (const m of raw) {
      expect(m.wideSetupNames).toBe(true);
      expect(InternalMcpMeta.safeParse(m).success).toBe(true);
    }
  });

  describe('through createServer', () => {
    let fake: Server;
    let url = '';
    const metas: any[] = [];
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
      return metas[metas.length - 1];
    }

    it('without Y_CLIENT_IP_HEADER the X-Forwarded-For key is marked forwarded_for', async () => {
      const prev = process.env.Y_CLIENT_IP_HEADER;
      delete process.env.Y_CLIENT_IP_HEADER;
      try {
        const server = createServer({ logging: false, core: { coreUrl: url, ...CORE } });
        const m = await callStatus(server, { 'x-forwarded-for': '10.0.0.1, 198.51.100.9' });
        expect(m.clientKey).toBe(clientKeyFor('198.51.100.9'));
        expect(m.clientKeySource).toBe('forwarded_for');
        expect(m.wideSetupNames).toBe(true);
      } finally {
        if (prev !== undefined) process.env.Y_CLIENT_IP_HEADER = prev;
      }
    });

    it('with a trusted header the key is marked header', async () => {
      const server = createServer({ logging: false, clientIpHeader: 'cf-connecting-ip', core: { coreUrl: url, ...CORE } });
      const m = await callStatus(server, { 'x-forwarded-for': '198.51.100.9', 'cf-connecting-ip': '192.0.2.4' });
      expect(m.clientKey).toBe(clientKeyFor('192.0.2.4'));
      expect(m.clientKeySource).toBe('header');
    });
  });
});
