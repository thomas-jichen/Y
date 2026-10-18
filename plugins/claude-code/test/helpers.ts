/** Test helpers: a fake core (node:http on 127.0.0.1), temp data dirs, env, synthetic secrets. */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export type Route = (req: Recorded) => { status?: number; body?: unknown; delayMs?: number } | undefined;

export interface FakeCore {
  url: string;
  requests: Recorded[];
  route: Route;
  close(): Promise<void>;
}

export async function startFakeCore(route: Route): Promise<FakeCore> {
  const core: FakeCore = { url: '', requests: [], route, close: async () => {} };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const rec: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      core.requests.push(rec);
      const out = core.route(rec) ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no route', retryable: false } } };
      setTimeout(() => {
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
        res.end(out.body === undefined ? '' : JSON.stringify(out.body));
      }, out.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  core.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  core.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return core;
}

export function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'y-plugin-test-'));
}

export function testEnv(dataDir: string, apiUrl: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    Y_DATA_DIR: dataDir,
    CLAUDE_PLUGIN_OPTION_AGENT_TOKEN: 'tok_test_install_0000000000',
    CLAUDE_PLUGIN_OPTION_API_URL: apiUrl,
    HOME: dataDir,
    ...extra,
  };
}

/** A fake GitHub PAT: right shape, random, never valid. Generated at runtime so nothing secret-shaped is committed. */
export function fakeGhp(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(36);
  return `ghp_${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`;
}

export const ULID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

/** A valid v1 brief (capture on) with the given pointers and notices. */
export function brief(pointers: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    tokenState: 'ok',
    agent: { id: '00000000-0000-4000-8000-000000000001', handle: '@test-agent', harness: 'claude_code' },
    minPluginVersion: '0.1.0',
    killSwitches: { pushPaths: false, networkContent: false, apply: false, ingest: false },
    pointers,
    pulseToken: { token: 'pulse_token_abcdefghijklmnop', expiresAt: '2099-01-01T00:00:00.000Z' },
    policy: { shareMode: 'stats', holdMinutes: 0, capture: 'on', wakeOnDm: 'teammates', policyAccepted: true, distiller: 'server' },
    humanNotices: [],
    serverTime: '2026-10-17T10:00:00.000Z',
    ...extra,
  };
}
