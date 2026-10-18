/**
 * Test harness for posts/: the messaging fake deps (PGlite, MemoryBus, fake
 * auth) with the internal MCP API and the posts web routes, three people
 * (alice and bob share team acme; carol is a stranger in team zeta), and
 * seed helpers. Tests use the real @y/safety cascade (no network).
 */
import { Hono } from 'hono';
import type { Caller, CoreModule } from '../contracts.js';
import { internalMcpModule } from '../internal-mcp/index.js';
import { agentCaller, callTool, makeEnv, seedPerson, seedTeam, webCaller, type Person, type TestEnv } from '../messaging/test-support.js';
import { registerWebGuards } from '../platform/web-guard.js';
import { takeToken, type BucketSpec } from '../platform/rate-limit.js';
import { registerPostsRoutes } from './routes.js';

export const postsWebModule: CoreModule = { register: registerPostsRoutes, jobs: {} };

export interface PostsEnv extends TestEnv {
  alice: Person; bob: Person; carol: Person;
  /** Alice's second agent (same owner, different agent). */
  alice2: Person;
  acme: string; zeta: string;
  /** Agent bearer tokens. */
  A: string; A2: string; B: string; C: string;
  /** Web (human) bearer tokens, logged in just now (step-up passes). */
  Aw: string; Bw: string; Cw: string;
}

/** A human caller whose login is `ageS` seconds old (step-up, I5). */
export function freshWebCaller(p: Person, ageS = 60): Caller {
  return { ...webCaller(p), authTime: Math.floor(Date.now() / 1000) - ageS };
}

export async function makePostsEnv(opts: { guards?: boolean } = {}): Promise<PostsEnv> {
  const env = await makeEnv([internalMcpModule, postsWebModule]);
  if (opts.guards) {
    // createApp order: guards first, then the routes.
    const app = new Hono();
    registerWebGuards(app, env.deps);
    internalMcpModule.register(app, env.deps);
    postsWebModule.register(app, env.deps);
    env.app = app;
  }
  const alice = await seedPerson(env.db, 'alice');
  const bob = await seedPerson(env.db, 'bob');
  const carol = await seedPerson(env.db, 'carol');
  const r = await env.db.query<{ id: string }>(
    `insert into public.agents (owner_user_id, handle, harness) values ($1, 'alice-cx', 'codex') returning id`, [alice.userId]);
  const alice2: Person = { ...alice, agentId: r.rows[0]!.id, agentHandle: '@alice-cx' };
  const acme = await seedTeam(env.db, 'acme', [alice, bob]);
  const zeta = await seedTeam(env.db, 'zeta', [carol]);
  return Object.assign(env, {
    alice, bob, carol, alice2, acme, zeta,
    A: env.token('alice-agent', agentCaller(alice)),
    A2: env.token('alice-agent-2', agentCaller(alice2)),
    B: env.token('bob-agent', agentCaller(bob)),
    C: env.token('carol-agent', agentCaller(carol)),
    Aw: env.token('alice-web', freshWebCaller(alice)),
    Bw: env.token('bob-web', freshWebCaller(bob)),
    Cw: env.token('carol-web', freshWebCaller(carol)),
  });
}

export const tool = callTool;

let keyN = 0;
/** A fresh idempotency key. */
export function key(prefix = 'key'): string {
  keyN += 1;
  return `${prefix}-${process.pid}-${keyN}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Text a teammate would post: clean, own words, no code or paths. */
export function tipBody(topic: string): string {
  return `When ${topic} keeps timing out, raise the hook timeout instead of the test timeout; it fixed our flaky setup.`;
}

/** Clean prose of exactly `n` characters. */
export function longText(n: number): string {
  return 'Raising the hook timeout fixed the flaky setup for our whole team this week. '.repeat(Math.ceil(n / 77)).slice(0, n);
}

/** create_post as `auth`; returns the tool body. */
export async function post(env: PostsEnv, auth: string, body: string, extra: Record<string, unknown> = {}) {
  return tool(env, 'create_post', auth, { kind: 'tip', body, tags: ['test_debugging'], idempotency_key: key('post'), ...extra });
}

/** Use up a bucket so the next take is refused. */
export async function drainBucket(env: PostsEnv, caller: Caller, scope: string, parts: string[], spec: BucketSpec): Promise<void> {
  await env.db.asUser(caller.claims, async (tx) => {
    for (let i = 0; i < spec.burst + 1; i++) await takeToken(tx, scope, parts, spec);
  });
}

/** Web JSON call. */
export async function web(env: PostsEnv, method: string, path: string, auth: string | undefined, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (auth) h.authorization = auth;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await env.app.request(path, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as any };
}

/** Engage or release a kill switch (superuser, like an operator). */
export async function setKillSwitch(env: PostsEnv, name: 'network_content', engaged: boolean): Promise<void> {
  await env.db.query(`update public.kill_switches set engaged = $2 where name = $1`, [name, engaged]);
}

/** Turn remote instructions on or off for an agent. */
export async function setRemoteInstructions(env: PostsEnv, agentId: string, on: boolean): Promise<void> {
  await env.db.query(
    `insert into public.agent_settings (agent_id, remote_instructions) values ($1, $2)
     on conflict (agent_id) do update set remote_instructions = excluded.remote_instructions`, [agentId, on]);
}

/** Events of a type published so far. */
export function eventsOf(env: PostsEnv, type: string) {
  return env.bus.events.filter((e) => e.type === type);
}

export type { Person };
export { agentCaller, webCaller };
