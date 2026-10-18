import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  INTERNAL_SIGNATURE_MAX_SKEW_S,
  REVIEW_QUEUE_NOTE,
  internalSigningString,
  makeError,
  parseInternalSignatureHeader,
  toMcpErrorBody,
  type StatusOutput,
} from '@y/schema';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from './app.js';
import { INSTRUCTIONS_MAX_CHARS, SERVER_INSTRUCTIONS } from './instructions.js';
import { SLICE_TOOLS } from './tools.js';

const SECRET = 'test-internal-secret-0123456789';
const TOKEN = 'Bearer pl_test_token_abcdefghijklmnop';

/* ------------------------------------------------------------ fake core */

interface Recorded {
  path: string;
  authorization: string | undefined;
  body: { input: unknown; meta?: unknown };
  sigOk: boolean;
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function verify(req: IncomingMessage, raw: string): boolean {
  const header = req.headers['x-y-internal'];
  if (typeof header !== 'string') return false;
  const parsed = parseInternalSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(Date.now() / 1000 - parsed.timestamp) > INTERNAL_SIGNATURE_MAX_SKEW_S) return false;
  const auth = req.headers.authorization;
  const expected = createHmac('sha256', SECRET)
    .update(
      internalSigningString({
        timestamp: parsed.timestamp,
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0] ?? '',
        bodySha256: sha(raw),
        authSha256: auth ? sha(auth) : '-',
      }),
    )
    .digest();
  const got = Buffer.from(parsed.hmacHex, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const statusOut = (signedIn: boolean): StatusOutput => ({
  signed_in: signedIn,
  token_state: signedIn ? 'ok' : null,
  agent: signedIn ? { handle: '@vivan-claude', harness: 'claude_code', presence: 'live' } : null,
  unread: { dm: signedIn ? 2 : 0, owner_instructions: 0, reviews: 1, suggestions: 0 },
  pending: { drafts: 1, change_requests: 0, approved_changes: 0 },
  next: signedIn ? [{ tool: 'inbox', reason: 'unread_dms' }] : [{ tool: 'status', reason: 'sign_in' }],
  kill_switches: { push_paths: false, network_content: false, apply: false, ingest: false },
  min_plugin_version: null,
  sign_in_url: signedIn ? null : 'http://localhost:5173/connect',
  server_time: '2026-10-17T12:00:00.000Z',
});

/** Per-tool canned replies; a test may override one. */
let replies: Record<string, (r: Recorded) => unknown> = {};
const defaultReplies: Record<string, (r: Recorded) => unknown> = {
  status: (r) => ({ ok: true, output: statusOut(Boolean(r.authorization)) }),
  search_network: (r) => ({
    ok: true,
    output: { results: [], scopes_searched: r.authorization ? ['team', 'public'] : ['public'], signed_in: Boolean(r.authorization) },
  }),
  review_queue: () => ({ ok: true, output: { items: [], counts: {}, note: REVIEW_QUEUE_NOTE } }),
  // Core's internal MCP API answers errors in MCP casing.
  send_message: () => toMcpErrorBody(makeError('DM_NOT_PERMITTED', 'This recipient does not accept DMs from you.')),
};

let recorded: Recorded[] = [];
let fakeCore: Server;
let coreUrl = '';

beforeAll(async () => {
  fakeCore = createHttpServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      const r: Recorded = {
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body: JSON.parse(raw || '{}'),
        sigOk: verify(req, raw),
      };
      recorded.push(r);
      res.setHeader('content-type', 'application/json');
      if (!r.sigOk) {
        res.statusCode = 401;
        res.end(JSON.stringify(makeError('UNAUTHORIZED', 'bad internal signature')));
        return;
      }
      const tool = r.path.replace('/internal/mcp/', '');
      const reply = replies[tool] ?? defaultReplies[tool];
      res.end(JSON.stringify(reply ? reply(r) : makeError('NOT_FOUND', `no canned reply for ${tool}`)));
    });
  });
  await new Promise<void>((resolve) => fakeCore.listen(0, '127.0.0.1', resolve));
  coreUrl = `http://127.0.0.1:${(fakeCore.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fakeCore.close(() => resolve()));
});

afterEach(() => {
  recorded = [];
  replies = {};
});

/* ------------------------------------------------------- MCP over HTTP */

function mcp(opts: { secret?: string; url?: string } = {}) {
  const server = createServer({
    logging: false,
    core: { coreUrl: opts.url ?? coreUrl, internalSecret: opts.secret ?? SECRET, webUrl: 'http://localhost:5173' },
  });
  let id = 0;
  async function rpc(method: string, params: unknown, headers: Record<string, string> = {}): Promise<any> {
    const res = await server.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      }),
    );
    const text = await res.text();
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    const msg = JSON.parse(dataLine ? dataLine.slice(6) : text);
    if (msg.error) throw new Error(`rpc error: ${JSON.stringify(msg.error)}`);
    return msg.result;
  }
  const call = (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
    rpc('tools/call', { name, arguments: args }, headers);
  return { rpc, call };
}

/* ---------------------------------------------------------------- tests */

describe('tool listing', () => {
  it('lists exactly the slice tools in the canonical order', async () => {
    const { tools } = await mcp().rpc('tools/list', {});
    expect(tools.map((t: { name: string }) => t.name)).toEqual([...SLICE_TOOLS]);
    for (const cut of ['scroll_feed', 'compare_setups', 'propose_setup_change', 'find_builder', 'ask_builder', 'whats_happening']) {
      expect(tools.find((t: { name: string }) => t.name === cut)).toBeUndefined();
    }
  });

  it('sets anthropic/alwaysLoad only on status, search_network and inbox', async () => {
    const { tools } = await mcp().rpc('tools/list', {});
    const always = tools.filter((t: any) => t._meta?.['anthropic/alwaysLoad'] === true).map((t: any) => t.name);
    expect(always).toEqual(['status', 'search_network', 'inbox']);
  });

  it('sets annotations and input/output schemas', async () => {
    const { tools } = await mcp().rpc('tools/list', {});
    const by = Object.fromEntries(tools.map((t: any) => [t.name, t]));
    for (const n of ['status', 'search_network', 'get_item', 'review_queue']) expect(by[n].annotations.readOnlyHint).toBe(true);
    for (const n of ['inbox', 'send_message', 'update_thread', 'report_outcome', 'post_activity']) {
      expect(by[n].annotations.readOnlyHint).toBe(false);
    }
    expect(by.send_message.annotations.openWorldHint).toBe(true);
    expect(by.post_activity.annotations.idempotentHint).toBe(false);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.outputSchema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it('sends server instructions within budget and exposes the y skill', async () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
    const c = mcp();
    const init = await c.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '1' },
    });
    expect(init.instructions).toBe(SERVER_INSTRUCTIONS);
    const { resources } = await c.rpc('resources/list', {});
    expect(resources.map((r: { uri: string }) => r.uri)).toContain('skill://y/SKILL.md');
  });
});

describe('forwarding to core', () => {
  it('signed-out status still calls core, signed, without Authorization', async () => {
    const res = await mcp().call('status', {});
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual(statusOut(false));
    expect(JSON.parse(res.content[0].text)).toEqual(statusOut(false));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.path).toBe('/internal/mcp/status');
    expect(recorded[0]!.authorization).toBeUndefined();
    expect(recorded[0]!.sigOk).toBe(true);
  });

  it('forwards the caller Authorization unchanged and the parsed input', async () => {
    const res = await mcp().call(
      'search_network',
      { query: 'pglite vector extension fails to load', error: 'Error: extension "vector" is not available' },
      { authorization: TOKEN },
    );
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ results: [], scopes_searched: ['team', 'public'], signed_in: true });
    const r = recorded[0]!;
    expect(r.authorization).toBe(TOKEN);
    expect(r.sigOk).toBe(true);
    expect(r.body.input).toEqual({
      query: 'pglite vector extension fails to load',
      error: 'Error: extension "vector" is not available',
      scope: 'all',
      limit: 5,
    });
  });

  it('auth-required tools without a token return UNAUTHORIZED guidance and never call core', async () => {
    for (const [name, args] of [
      ['inbox', {}],
      ['review_queue', {}],
    ] as const) {
      const res = await mcp().call(name, args);
      expect(res.isError).toBe(true);
      expect(res.structuredContent.error.code).toBe('UNAUTHORIZED');
      expect(res.structuredContent.error.retryable).toBe(false);
      expect(res.structuredContent.error.next).toEqual({ human_action: 'reconnect', url: 'http://localhost:5173/connect' });
    }
    expect(recorded).toHaveLength(0);
  });

  it('auth-required tool with a token forwards and validates output', async () => {
    const res = await mcp().call('review_queue', {}, { authorization: TOKEN });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.note).toBe(REVIEW_QUEUE_NOTE);
    expect(recorded[0]!.authorization).toBe(TOKEN);
  });
});

describe('error mapping', () => {
  it('maps a core error body to an MCP error result unchanged', async () => {
    const res = await mcp().call(
      'send_message',
      { to: '@stranger-agent', body: 'hi, how did you fix the pgvector import?', intent: 'question', idempotency_key: 'idem-key-0001' },
      { authorization: TOKEN },
    );
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toEqual(toMcpErrorBody(makeError('DM_NOT_PERMITTED', 'This recipient does not accept DMs from you.')));
    expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
  });

  it('surfaces RATE_LIMITED with retry_after_s from send_message', async () => {
    replies.send_message = () => toMcpErrorBody(makeError('RATE_LIMITED', 'send_message is limited to 30 per hour', { retryAfterS: 120 }));
    const res = await mcp().call(
      'send_message',
      { to: '@maya-claude', body: 'one more thing', intent: 'fyi', idempotency_key: 'idem-key-0002' },
      { authorization: TOKEN },
    );
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retry_after_s: 120 });
  });

  it('maps network failures to INTERNAL retryable', async () => {
    const res = await mcp({ url: 'http://127.0.0.1:9' }).call('status', {});
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe('INTERNAL');
    expect(res.structuredContent.error.retryable).toBe(true);
  });

  it('a bad HMAC is rejected by core and surfaces as UNAUTHORIZED', async () => {
    const res = await mcp({ secret: 'wrong-secret' }).call('status', {});
    expect(recorded[0]!.sigOk).toBe(false);
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe('UNAUTHORIZED');
  });

  it('an output that violates the contract becomes INTERNAL', async () => {
    replies.status = () => ({ ok: true, output: { signedIn: 'yes' } });
    const res = await mcp().call('status', {});
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe('INTERNAL');
  });

  it('non-JSON core replies become INTERNAL', async () => {
    replies.status = () => undefined; // JSON.stringify(undefined) → empty body
    const res = await mcp().call('status', {});
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe('INTERNAL');
  });

  it('invalid input is rejected before core is called', async () => {
    const res = await mcp().call('search_network', { query: 'x' }).catch((e: Error) => ({ rpcError: e.message }));
    expect('rpcError' in res || res.isError === true).toBe(true);
    expect(recorded).toHaveLength(0);
  });
});
