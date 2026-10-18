/**
 * Test harness for messaging / internal-mcp: a minimal fake CoreDeps on
 * createTestDb() (fake auth with fixed callers, an in-memory bus, an inline
 * job queue, a 384-dim hashed embedder) and seed helpers.
 */
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { createAuthUser, createTestDb, type Db } from '@paceline/db';
import type { Caller, CoreConfig, CoreDeps, CoreModule, JobHandler, PushEvent } from '../contracts.js';

export const GOOD_HMAC = 't=1700000000,v1=' + 'a'.repeat(64);

export class MemoryBus {
  events: (PushEvent & { seq: number })[] = [];
  private waiters: (() => void)[] = [];
  async publish(event: PushEvent) {
    this.events.push({ ...event, seq: this.events.length + 1 });
    const w = this.waiters; this.waiters = [];
    for (const f of w) f();
  }
  private after(agentId: string, cursor: string | null) {
    const c = Number(cursor ?? 0) || 0;
    return this.events.filter((e) => e.seq > c && e.audienceAgentIds.includes(agentId));
  }
  async waitForAgent(agentId: string, cursor: string | null, timeoutMs: number) {
    let found = this.after(agentId, cursor);
    if (found.length === 0 && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
      found = this.after(agentId, cursor);
    }
    const last = this.events.length ? String(this.events[this.events.length - 1]!.seq) : cursor;
    return { events: found, cursor: last };
  }
  subscribeUser() { return () => {}; }
}

export interface TestEnv {
  db: Db;
  deps: CoreDeps;
  bus: MemoryBus;
  app: Hono;
  callers: Map<string, Caller>;
  /** Register a bearer token for a caller. */
  token(name: string, caller: Caller): string;
}

function mockEmbed(text: string): number[] {
  const v = new Array<number>(384).fill(0);
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const h = createHash('sha256').update(w).digest();
    v[h.readUInt16BE(0) % 384]! += 1;
  }
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / n);
}

export async function makeEnv(modules: CoreModule[]): Promise<TestEnv> {
  const db = await createTestDb();
  const bus = new MemoryBus();
  const callers = new Map<string, Caller>();
  const jobs: Record<string, JobHandler> = Object.assign({}, ...modules.map((m) => m.jobs));
  const queue: { topic: string; payload: Record<string, unknown> }[] = [];
  const config: CoreConfig = {
    port: 0, publicUrl: 'http://localhost:8787', mode: 'server', internalSecret: 'x', hmacKey: 'x', signingKeyPkcs8B64: null,
    llm: 'mock', embeddings: 'mock', anthropicApiKey: null, devAuth: true, supabase: { url: null, jwksUrl: null, serviceKey: null },
  };
  const deps: CoreDeps = {
    config, db,
    auth: {
      async verifyBearer(h) { return h?.startsWith('Bearer ') ? callers.get(h.slice(7)) ?? null : null; },
      verifyInternal(req) { return req.header('x-paceline-internal') === GOOD_HMAC; },
    },
    bus,
    jobs: {
      async enqueue(topic, payload) { queue.push({ topic, payload }); },
      async drain() { let n = 0; while (queue.length) { const j = queue.shift()!; await jobs[j.topic]?.(j.payload, deps); n++; } return n; },
    },
    embedder: { dims: 384, async embed(texts) { return texts.map(mockEmbed); } },
    now: () => new Date(),
    log: (level, msg, data) => { if (process.env.PACELINE_TEST_LOG) console.error(level, msg, JSON.stringify(data)); },
  };
  const app = new Hono();
  for (const m of modules) m.register(app, deps);
  return {
    db, deps, bus, app, callers,
    token(name, caller) { callers.set(name, caller); return `Bearer ${name}`; },
  };
}

export interface Person { userId: string; agentId: string; handle: string; agentHandle: string }

export async function seedPerson(db: Db, login: string): Promise<Person> {
  const userId = await createAuthUser(db, { userMetadata: { user_name: login } });
  const r = await db.query<{ id: string }>(
    `insert into public.agents (owner_user_id, handle, harness) values ($1, $2, 'claude_code') returning id`, [userId, `${login}-cc`]);
  return { userId, agentId: r.rows[0]!.id, handle: `@${login}`, agentHandle: `@${login}-cc` };
}

export async function seedTeam(db: Db, slug: string, members: Person[]): Promise<string> {
  const r = await db.query<{ id: string }>(`insert into public.teams (slug, name) values ($1, $2) returning id`, [slug, slug]);
  const teamId = r.rows[0]!.id;
  for (const m of members) await db.query(`insert into public.team_members (team_id, user_id, role) values ($1, $2, 'member')`, [teamId, m.userId]);
  return teamId;
}

export function agentCaller(p: Person): Caller {
  return { userId: p.userId, agentId: p.agentId, installId: null, via: 'install', claims: { sub: p.userId, agent_id: p.agentId, via: 'install' } };
}

export function webCaller(p: Person): Caller {
  return { userId: p.userId, agentId: null, installId: null, via: 'web', claims: { sub: p.userId, via: 'web' } };
}

/** Call POST /internal/mcp/:tool. */
export async function callTool(env: TestEnv, tool: string, auth: string | undefined, input: unknown, hmac = GOOD_HMAC) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-paceline-internal': hmac };
  if (auth) headers.authorization = auth;
  const res = await env.app.request(`/internal/mcp/${tool}`, { method: 'POST', headers, body: JSON.stringify({ input }) });
  return { status: res.status, body: (await res.json()) as any };
}
