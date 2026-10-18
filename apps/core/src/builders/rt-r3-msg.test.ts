/**
 * Red-team round 3 (r3-msg) for builders: ordinary product names pass the label screen and stay
 * visible to find_builder (R14), the 9105 migration no longer rewrites existing auto_send
 * products and the API checks auto_send consent only when it is newly enabled (R3/R13/R37),
 * and verified products still match their slug in error text (R9/R36). Fake fetch, PGlite,
 * no network. Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FindBuilderOutput, Product } from '@y/schema';
import { internalMcpModule } from '../internal-mcp/index.js';
import { messagingModule } from '../messaging/index.js';
import { agentCaller, callTool, makeEnv, seedPerson, webCaller, type Person, type TestEnv } from '../messaging/test-support.js';
import { migrateCore, platformModule } from '../platform/index.js';
import { buildersModule } from './index.js';
import { cleanProductLabel } from './labels.js';
import { readFile } from 'node:fs/promises';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let env: TestEnv;
let lena: Person; let mo: Person; let vivan: Person; let eve: Person;
let teamId: string; let eveTeam: string;
let fetched: string[];
let markers: Record<string, unknown>;

function fakeFetch(url: string): Promise<Response> {
  fetched.push(url);
  const body = markers[url];
  if (body === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

beforeEach(async () => {
  env = await makeEnv([platformModule, messagingModule, internalMcpModule, buildersModule]);
  await migrateCore(env.db);
  fetched = [];
  markers = {
    'https://acme-pay.dev/.well-known/y.json': { products: ['acme-pay'] },
    'https://registry.npmjs.org/acme-pay-sdk/latest': { name: 'acme-pay-sdk', y: { product: 'acme-pay' } },
  };
  env.deps.fetch = fakeFetch as typeof fetch;
  lena = await seedPerson(env.db, 'lena');
  mo = await seedPerson(env.db, 'mo');
  vivan = await seedPerson(env.db, 'vivan');
  eve = await seedPerson(env.db, 'eve');
  teamId = (await env.db.query<{ id: string }>(`insert into public.teams (slug, name) values ('acme-team', 'Acme') returning id`)).rows[0]!.id;
  await env.db.query(`insert into public.team_members (team_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member')`, [teamId, lena.userId, mo.userId]);
  eveTeam = (await env.db.query<{ id: string }>(`insert into public.teams (slug, name) values ('eve-team', 'Eve') returning id`)).rows[0]!.id;
  await env.db.query(`insert into public.team_members (team_id, user_id, role) values ($1, $2, 'owner')`, [eveTeam, eve.userId]);
});
afterEach(async () => { await env.db.close(); });

// A web session signed in just now (auto_send and activation need a recent sign-in).
const web = (p: Person) => env.token(`${p.handle}-web`, { ...webCaller(p), authTime: Math.floor(Date.now() / 1000) });
const agent = (p: Person) => env.token(`${p.handle}-agent`, agentCaller(p));
async function api(method: string, path: string, auth: string | null, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  const res = await env.app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}
const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const find = async (input: Record<string, unknown>, auth: string | undefined = agent(vivan)) =>
  FindBuilderOutput.parse((await callTool(env, 'find_builder', auth, input)).body.output).builders;

/** Create a product as `who` and verify the given claims (markers must be set). */
async function product(who: Person, slug: string, name: string, claims: [string, string][], extra: Record<string, unknown> = {}): Promise<Product> {
  const created = await api('POST', '/api/v1/products', web(who), { slug, name, builderAgent: who.agentHandle, ...extra });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  for (const [kind, value] of claims) {
    expect((await api('POST', `/api/v1/products/${created.body.id}/claims`, web(who), { kind, value })).status).toBe(200);
    expect((await api('POST', `/api/v1/products/${created.body.id}/claims/verify`, web(who), { kind, value })).body.verified).toBe(true);
  }
  return Product.parse((await api('GET', '/api/v1/products', web(who))).body.find((p: Product) => p.slug === slug));
}

const BENIGN = ['Always-On Agent', 'LLM Required', 'Please AI', 'Forget-Me-Not AI', 'bypass-proxy-agent', 'npx-run', 'wget-curl', 'Exec Install'];

describe('R14 ordinary product names', () => {
  it('pass the label screen', () => {
    for (const name of BENIGN) expect(cleanProductLabel(name), name).toBe(true);
  });

  it('can be registered, and a stored one stays visible to find_builder', async () => {
    markers['https://npx-run.dev/.well-known/y.json'] = { products: ['npx-run'] };
    const p = await product(lena, 'npx-run', 'Always-On Agent', [['domain', 'npx-run.dev']]);
    expect(p.labelHidden).toBeUndefined();
    expect((await find({ domain: 'npx-run.dev' }))[0]).toMatchObject({ slug: 'npx-run', name: 'Always-On Agent' });
    // A name stored before the screen (written directly) is not hidden either.
    for (const name of BENIGN) {
      await env.db.query(`update public.products set name = $2 where id = $1`, [p.id.slice(2), name]);
      expect((await find({ domain: 'npx-run.dev' }))[0]?.name, name).toBe(name);
    }
    const bypass = await api('POST', '/api/v1/products', web(lena), { slug: 'bypass-proxy-agent', name: 'Bypass Proxy Agent', builderAgent: lena.agentHandle });
    expect(bypass.status).toBe(200);
  });
});

describe('R3/R13/R37 existing auto_send products', () => {
  async function teammateAutoSend(): Promise<string> {
    const p = await api('POST', '/api/v1/products', web(lena), { slug: 'acme-cli', name: 'Acme CLI', builderAgent: lena.agentHandle, replyPolicy: 'auto_send' });
    expect(p.status).toBe(200);
    // As an admin could set it up before the consent rule: Mo's agent on auto_send.
    await env.db.query(`update public.products set builder_agent_id = $2 where id = $1`, [p.body.id.slice(2), mo.agentId]);
    return p.body.id as string;
  }

  it('the 9105 migration leaves them as they are', async () => {
    const id = await teammateAutoSend();
    await env.db.exec(await readFile(new URL('../../migrations/9105_rt_builders.sql', import.meta.url), 'utf8'));
    const row = (await env.db.query<{ reply_policy: string; builder_agent_id: string }>(
      `select reply_policy, builder_agent_id from public.products where id = $1`, [id.slice(2)])).rows[0];
    expect(row).toEqual({ reply_policy: 'auto_send', builder_agent_id: mo.agentId });
  });

  it('editing one, or re-sending its auto_send policy, does not re-check consent', async () => {
    const id = await teammateAutoSend();
    expect((await api('PATCH', `/api/v1/products/${id}`, web(lena), { slaMinutes: 45 })).status).toBe(200);
    expect((await api('PATCH', `/api/v1/products/${id}`, web(lena), { name: 'Acme CLI Tools' })).status).toBe(200);
    const same = await api('PATCH', `/api/v1/products/${id}`, web(lena), { replyPolicy: 'auto_send' });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ replyPolicy: 'auto_send', builderAgent: { handle: mo.agentHandle } });
  });

  it('newly enabling auto_send for a teammate\'s agent still needs that teammate (I5)', async () => {
    const p = await api('POST', '/api/v1/products', web(lena), { slug: 'acme-pay', name: 'Acme Pay', builderAgent: mo.agentHandle });
    expect((await api('PATCH', `/api/v1/products/${p.body.id}`, web(lena), { replyPolicy: 'auto_send' })).status).toBe(400);
    const id = await teammateAutoSend();
    // Swapping the builder of an auto_send product to another agent enables it for that agent.
    expect((await api('PATCH', `/api/v1/products/${id}`, web(lena), { builderAgent: lena.agentHandle })).status).toBe(200);
    expect((await api('PATCH', `/api/v1/products/${id}`, web(lena), { builderAgent: mo.agentHandle })).status).toBe(400);
  });
});

describe('R9/R36 verified products still match their slug in error text', () => {
  it('a slug that is also its verified npm or PyPI package, or a multi-part slug on its own domain', async () => {
    markers['https://registry.npmjs.org/prisma-kit/latest'] = { name: 'prisma-kit', y: { product: 'prisma-kit' } };
    markers['https://pypi.org/pypi/acme_pay/json'] = { info: { project_urls: { Y: 'https://y.example/p/acme-pay' } } };
    markers['https://registry.npmjs.org/widgetly/latest'] = { name: 'widgetly', y: { product: 'widgetly' } };
    await product(lena, 'prisma-kit', 'Prisma Kit', [['npm', 'prisma-kit']]);
    await product(eve, 'acme-pay', 'Acme Pay', [['pypi', 'acme_pay']]);
    await product(eve, 'widgetly', 'Widgetly', [['npm', 'widgetly']]);
    expect((await find({ error: 'prisma-kit migrate failed: P3009 ...' }))[0]).toMatchObject({ slug: 'prisma-kit', matched_on: 'error' });
    expect((await find({ error: 'acme-pay: request failed with 401' }))[0]).toMatchObject({ slug: 'acme-pay', matched_on: 'error' });
    expect((await find({ error: 'widgetly: render failed' }))[0]).toMatchObject({ slug: 'widgetly', matched_on: 'error' });
  });
});
