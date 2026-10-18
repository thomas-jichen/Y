/**
 * In-process core + MCP for `pnpm demo:local` and the demo test: real core modules on an
 * in-memory PGlite database with the job loop running, and apps/mcp over real HTTP.
 * Also exposes the database for the two local-only setup steps the HTTP API can't do
 * (seeding public gotchas, and keeping zed out of the shared `dev` team).
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { createDb, createTestDb, migrate, type Db } from '@paceline/db';
import { allJobHandlers, createApp, createDeps, loadConfig, type CoreDeps } from '@paceline/core';
import { createServer as createMcpServer } from '@paceline/mcp';

export interface LocalStack {
  coreUrl: string;
  mcpUrl: string;
  db: Db;
  deps: CoreDeps;
  /** Removes the user from every team (dev login puts everyone in `dev`). */
  isolateStranger: (userId: string) => Promise<void>;
  stop: () => Promise<void>;
}

export interface LocalStackOptions {
  /** Core port; 0 picks a free one. Default 0. */
  corePort?: number;
  /** MCP port; 0 picks a free one. Default 0. */
  mcpPort?: number;
  /** Host used in URLs and PUBLIC_URL. Default 127.0.0.1. */
  host?: string;
  /** Interface to bind. Default 127.0.0.1 (loopback only: dev auth is on). */
  bindHost?: string;
  /** Shared core⇄mcp HMAC secret. Default random. */
  internalSecret?: string;
  /** Use the cached test template (fast) instead of migrating a fresh in-memory DB. */
  testTemplate?: boolean;
  /** Print core errors (and everything with PACELINE_DEBUG). */
  verbose?: boolean;
}

function freePort(host: string): Promise<number> {
  return new Promise((resolve) => {
    const s = serve({ fetch: () => new Response('booting', { status: 503 }), port: 0, hostname: host }, (info: AddressInfo) => {
      s.close(() => resolve(info.port));
    });
  });
}

function listen(fetch: (req: Request) => Response | Promise<Response>, port: number, host: string): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, port, hostname: host }, () => resolve(server));
    server.on('error', reject);
  });
}

export async function startLocalStack(opts: LocalStackOptions = {}): Promise<LocalStack> {
  const host = opts.host ?? '127.0.0.1';
  const bind = opts.bindHost ?? '127.0.0.1';
  const secret = opts.internalSecret ?? randomBytes(24).toString('hex');
  const corePort = opts.corePort || (await freePort(bind));
  const mcpPort = opts.mcpPort || (await freePort(bind));
  const coreUrl = `http://${host}:${corePort}`;
  const mcpBase = `http://${host}:${mcpPort}`;

  let db: Db;
  if (opts.testTemplate) {
    db = await createTestDb();
  } else {
    db = await createDb({ PACELINE_DATA_DIR: 'memory' });
    await migrate(db);
  }
  const config = loadConfig({
    PORT: String(corePort),
    PUBLIC_URL: coreUrl,
    PACELINE_INTERNAL_SECRET: secret,
    PACELINE_HMAC_KEY: randomBytes(16).toString('hex'),
    PACELINE_DEV_AUTH: '1',
    PACELINE_LLM: 'mock',
    PACELINE_EMBEDDINGS: 'mock',
  });
  const log: CoreDeps['log'] = (level, msg, data) => {
    if ((level === 'error' && opts.verbose) || process.env.PACELINE_DEBUG) console.error(`[core] ${level} ${msg}`, data ?? '');
  };
  const deps = await createDeps(config, db, allJobHandlers(), { scheduleRecurring: false, log });
  const app = createApp(deps);
  const coreServer = await listen(app.fetch, corePort, bind);

  let draining = false;
  const loop = setInterval(() => {
    if (draining) return;
    draining = true;
    deps.jobs
      .drain(20)
      .catch((e: unknown) => log('error', 'job loop', { e: String(e) }))
      .finally(() => (draining = false));
  }, 100);

  const mcp = createMcpServer({ logging: false, core: { coreUrl, internalSecret: secret, webUrl: 'http://localhost:5173' } });
  const mcpServer = await listen((req) => mcp.fetch(req), mcpPort, bind);

  const isolateStranger = async (userId: string): Promise<void> => {
    await db.query('delete from public.team_members where user_id = $1', [userId]);
  };

  const stop = async (): Promise<void> => {
    clearInterval(loop);
    while (draining) await new Promise((r) => setTimeout(r, 50));
    await new Promise<void>((r) => mcpServer.close(() => r()));
    await new Promise<void>((r) => coreServer.close(() => r()));
    await (deps.bus as { stop?: () => Promise<void> }).stop?.();
    await db.close();
  };

  return { coreUrl, mcpUrl: `${mcpBase}/mcp`, db, deps, isolateStranger, stop };
}
