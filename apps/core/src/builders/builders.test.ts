/**
 * M7 builders: products + claim verification (fake fetch, no network),
 * find_builder, ask_builder, support-thread routing and the builder approval
 * queue. Real @y/safety and @y/domain (outbound DLP must really hold code).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AskBuilderOutput,
  BuilderReplyReview,
  FindBuilderOutput,
  InboxOutput,
  MessageEnvelopeContent,
  Product,
  PublicBuilderClaims,
  ThreadDetail,
  VerifyClaimResponse,
  decodeUntrustedContent,
} from '@y/schema';
import { internalMcpModule } from '../internal-mcp/index.js';
import { messagingModule } from '../messaging/index.js';
import { agentCaller, callTool, makeEnv, seedPerson, webCaller, type Person, type TestEnv } from '../messaging/test-support.js';
import { migrateCore, platformModule } from '../platform/index.js';
import { buildersModule, composeQuestion, errorTokens } from './index.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let env: TestEnv;
let lena: Person; let mo: Person; let vivan: Person;
let teamId: string;
let fetched: string[];
let markers: Record<string, { status?: number; body?: unknown }>;

const SLUG = 'acme-pay';

function fakeFetch(url: string): Promise<Response> {
  fetched.push(url);
  const m = markers[url];
  if (!m) return Promise.resolve(new Response('not found', { status: 404 }));
  const status = m.status ?? 200;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (status >= 300 && status < 400) headers.location = 'http://169.254.169.254/latest';
  return Promise.resolve(new Response(status >= 300 && status < 400 ? null : JSON.stringify(m.body ?? {}), { status, headers }));
}

beforeEach(async () => {
  env = await makeEnv([platformModule, messagingModule, internalMcpModule, buildersModule]);
  await migrateCore(env.db);
  fetched = [];
  markers = {
    'https://acme-pay.dev/.well-known/y.json': { body: { products: [SLUG] } },
    'https://registry.npmjs.org/acme-pay-sdk/latest': { body: { name: 'acme-pay-sdk', version: '2.1.0', y: { product: SLUG } } },
    'https://raw.githubusercontent.com/acme/acme-pay/HEAD/.well-known/y.json': { body: { product: SLUG } },
    'https://pypi.org/pypi/acme-pay/json': { body: { info: { project_urls: { Homepage: 'https://acme-pay.dev', Y: `https://y.example/p/${SLUG}` } } } },
  };
  env.deps.fetch = fakeFetch as typeof fetch;
  lena = await seedPerson(env.db, 'lena');
  mo = await seedPerson(env.db, 'mo');
  vivan = await seedPerson(env.db, 'vivan');
  const t = await env.db.query<{ id: string }>(`insert into public.teams (slug, name) values ('acme-team', 'Acme') returning id`);
  teamId = t.rows[0]!.id;
  await env.db.query(`insert into public.team_members (team_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member')`, [teamId, lena.userId, mo.userId]);
});
afterEach(async () => { await env.db.close(); });

const web = (p: Person) => env.token(`${p.handle}-web`, webCaller(p));
const agent = (p: Person) => env.token(`${p.handle}-agent`, agentCaller(p));
async function api(method: string, path: string, auth: string | null, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  const res = await env.app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}
const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const ask = (p: Person, question: string, extra: Record<string, unknown> = {}) =>
  callTool(env, 'ask_builder', agent(p), { product: SLUG, question, idempotency_key: key(), ...extra });
const send = (p: Person, to: string, body: string, intent = 'answer') =>
  callTool(env, 'send_message', agent(p), { to, body, intent, idempotency_key: key() });
const inboxOf = async (p: Person) => InboxOutput.parse((await callTool(env, 'inbox', agent(p), { unread_only: false })).body.output);
const bodyOf = (e: InboxOutput['messages'][number]) => decodeUntrustedContent(e.untrusted_content, MessageEnvelopeContent).body;
const msgState = async (wireId: string) =>
  (await env.db.query<{ state: string; body: string }>(`select state, body from public.messages where id = $1`, [wireId.slice(2)])).rows[0]!;

/** Register acme-pay (lena's agent builds it) and verify its claims. */
async function activeProduct(replyPolicy?: 'auto_send'): Promise<Product> {
  const created = await api('POST', '/api/v1/products', web(lena), { slug: SLUG, name: 'Acme Pay', builderAgent: lena.agentHandle, slaMinutes: 120, ...(replyPolicy ? { replyPolicy } : {}) });
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  for (const [kind, value] of [['npm', 'acme-pay-sdk'], ['github_repo', 'acme/acme-pay'], ['domain', 'acme-pay.dev']] as const) {
    expect((await api('POST', `/api/v1/products/${id}/claims`, web(lena), { kind, value })).status).toBe(200);
    const v = await api('POST', `/api/v1/products/${id}/claims/verify`, web(lena), { kind, value });
    expect(v.body.verified).toBe(true);
  }
  return Product.parse((await api('GET', '/api/v1/products', web(lena))).body[0]);
}

describe('products and claims', () => {
  it('lets a team admin register a product and verify each claim kind through the injected fetch', async () => {
    const created = await api('POST', '/api/v1/products', web(lena), { slug: SLUG, name: 'Acme Pay', builderAgent: lena.agentHandle });
    expect(created.status).toBe(200);
    const p = Product.parse(created.body);
    expect(p).toMatchObject({ slug: SLUG, status: 'pending', replyPolicy: 'builder_approves', slaMinutes: 1440, teamId });
    expect(p.builderAgent?.handle).toBe(lena.agentHandle);

    for (const [kind, value] of [['domain', 'acme-pay.dev'], ['npm', 'acme-pay-sdk'], ['github_repo', 'acme/acme-pay'], ['pypi', 'acme-pay']] as const) {
      const added = await api('POST', `/api/v1/products/${p.id}/claims`, web(lena), { kind, value });
      expect(added.status).toBe(200);
      expect(added.body.claims.find((c: { kind: string }) => c.kind === kind).marker).toContain(SLUG);
      const v = VerifyClaimResponse.parse((await api('POST', `/api/v1/products/${p.id}/claims/verify`, web(lena), { kind, value })).body);
      expect(v.verified).toBe(true);
      // The first verified claim (with a builder agent) activates the product.
      expect(v.product.status).toBe('active');
    }
    expect(fetched).toEqual([
      'https://acme-pay.dev/.well-known/y.json',
      'https://registry.npmjs.org/acme-pay-sdk/latest',
      'https://raw.githubusercontent.com/acme/acme-pay/HEAD/.well-known/y.json',
      'https://pypi.org/pypi/acme-pay/json',
    ]);
    const list = (await api('GET', '/api/v1/products', web(mo))).body as Product[];
    expect(list[0]!.claims.every((c) => c.verifiedAt)).toBe(true);

    // Public P7 list: package claims only, no auth, cacheable.
    const pub = await api('GET', '/api/v1/builders/claims', null);
    expect(pub.status).toBe(200);
    expect(pub.headers.get('cache-control')).toContain('max-age');
    expect(PublicBuilderClaims.parse(pub.body).claims).toEqual([
      { kind: 'npm', value: 'acme-pay-sdk', product_id: p.id },
      { kind: 'pypi', value: 'acme-pay', product_id: p.id },
    ]);
  });

  it('reports a missing marker, refuses redirects, and answers CONFLICT for a value another product owns', async () => {
    const p = await activeProduct();
    markers['https://registry.npmjs.org/acme-pay-ui/latest'] = { body: { name: 'acme-pay-ui', y: { product: 'someone-else' } } };
    markers['https://docs.acme-pay.io/.well-known/y.json'] = { status: 302 };
    await api('POST', `/api/v1/products/${p.id}/claims`, web(lena), { kind: 'npm', value: 'acme-pay-ui' });
    await api('POST', `/api/v1/products/${p.id}/claims`, web(lena), { kind: 'domain', value: 'docs.acme-pay.io' });
    expect((await api('POST', `/api/v1/products/${p.id}/claims/verify`, web(lena), { kind: 'npm', value: 'acme-pay-ui' })).body)
      .toMatchObject({ verified: false, reason: 'marker_missing' });
    expect((await api('POST', `/api/v1/products/${p.id}/claims/verify`, web(lena), { kind: 'domain', value: 'docs.acme-pay.io' })).body)
      .toMatchObject({ verified: false, reason: 'redirect' });
    // A claim that was never added cannot be verified.
    expect((await api('POST', `/api/v1/products/${p.id}/claims/verify`, web(lena), { kind: 'pypi', value: 'nope' })).status).toBe(404);

    // Mo's second team registers a product claiming the same npm package: verification conflicts.
    const t2 = await env.db.query<{ id: string }>(`insert into public.teams (slug, name) values ('other-team', 'Other') returning id`);
    await env.db.query(`insert into public.team_members (team_id, user_id, role) values ($1, $2, 'owner')`, [t2.rows[0]!.id, mo.userId]);
    const other = await api('POST', '/api/v1/products', web(mo), { slug: 'copycat', name: 'Copycat', builderAgent: mo.agentHandle, teamId: t2.rows[0]!.id });
    expect(other.status).toBe(200);
    markers['https://registry.npmjs.org/acme-pay-sdk/latest'] = { body: { y: { product: 'copycat' } } };
    await api('POST', `/api/v1/products/${other.body.id}/claims`, web(mo), { kind: 'npm', value: 'acme-pay-sdk' });
    const clash = await api('POST', `/api/v1/products/${other.body.id}/claims/verify`, web(mo), { kind: 'npm', value: 'acme-pay-sdk' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('CONFLICT');
  });

  it('refuses non-admins and agents (I11), and activation without a verified claim', async () => {
    const byMember = await api('POST', '/api/v1/products', web(mo), { slug: 'mo-thing', name: 'Mo Thing', builderAgent: mo.agentHandle });
    expect(byMember.status).toBe(403);
    const byAgent = await api('POST', '/api/v1/products', agent(lena), { slug: 'agent-thing', name: 'Agent Thing', builderAgent: lena.agentHandle });
    expect(byAgent.status).toBe(403);
    // A builder agent must belong to a team member.
    const stranger = await api('POST', '/api/v1/products', web(lena), { slug: 'x-thing', name: 'X Thing', builderAgent: vivan.agentHandle });
    expect(stranger.status).toBe(400);

    const created = await api('POST', '/api/v1/products', web(lena), { slug: SLUG, name: 'Acme Pay', builderAgent: lena.agentHandle });
    const id = created.body.id as string;
    expect((await api('PATCH', `/api/v1/products/${id}`, web(lena), { status: 'active' })).status).toBe(400);
    await api('POST', `/api/v1/products/${id}/claims`, web(lena), { kind: 'npm', value: 'acme-pay-sdk' });
    // Agents (even the builder agent itself) and plain members cannot verify, add claims or edit.
    expect((await api('POST', `/api/v1/products/${id}/claims/verify`, agent(lena), { kind: 'npm', value: 'acme-pay-sdk' })).status).toBe(403);
    expect((await api('POST', `/api/v1/products/${id}/claims/verify`, web(mo), { kind: 'npm', value: 'acme-pay-sdk' })).status).toBe(403);
    expect((await api('POST', `/api/v1/products/${id}/claims`, web(mo), { kind: 'npm', value: 'acme-pay-x' })).status).toBe(403);
    expect((await api('PATCH', `/api/v1/products/${id}`, web(mo), { replyPolicy: 'auto_send' })).status).toBe(403);
    expect(fetched).toEqual([]);
    const row = await env.db.query<{ status: string; reply_policy: string }>(`select status, reply_policy from public.products`);
    expect(row.rows[0]).toEqual({ status: 'pending', reply_policy: 'builder_approves' });

    // Suspend + re-activate as the admin (a verified claim exists now).
    await api('POST', `/api/v1/products/${id}/claims/verify`, web(lena), { kind: 'npm', value: 'acme-pay-sdk' });
    expect((await api('PATCH', `/api/v1/products/${id}`, web(lena), { status: 'suspended' })).body.status).toBe('suspended');
    expect((await api('PATCH', `/api/v1/products/${id}`, web(lena), { status: 'active', slaMinutes: 60 })).body).toMatchObject({ status: 'active', slaMinutes: 60 });
  });
});

describe('find_builder', () => {
  it('matches package, repo, domain (and subdomains) and error text on verified claims of active products', async () => {
    const p = await activeProduct();
    const find = async (input: Record<string, unknown>, auth: string | undefined = agent(vivan)) =>
      FindBuilderOutput.parse((await callTool(env, 'find_builder', auth, input)).body.output).builders;

    const byPkg = await find({ package: 'Acme-Pay-SDK' });
    expect(byPkg).toHaveLength(1);
    expect(byPkg[0]).toMatchObject({ product_id: p.id, slug: SLUG, name: 'Acme Pay', builder_agent: lena.agentHandle, presence: 'away', sla_minutes: 120, matched_on: 'package' });
    expect(byPkg[0]!.claims.map((c) => c.kind).sort()).toEqual(['domain', 'github_repo', 'npm']);
    expect((await find({ package: 'acme-pay-sdk', ecosystem: 'pypi' }))).toHaveLength(0);
    expect((await find({ repo: 'acme/acme-pay' }))[0]?.matched_on).toBe('repo');
    expect((await find({ domain: 'api.acme-pay.dev' }))[0]?.matched_on).toBe('domain');
    expect((await find({ domain: 'notacme-pay.dev' }))).toHaveLength(0);
    expect((await find({ error: "Error: Cannot verify webhook signature (node_modules/acme-pay-sdk/dist/webhooks.js:41)" }))[0]?.matched_on).toBe('error');
    expect((await find({ error: 'AcmePayError from acme-pay: invalid signature header' }))[0]?.slug).toBe(SLUG);
    expect((await find({ error: 'TypeError: undefined is not a function' }))).toHaveLength(0);

    // Signed out: public data only, same answer for active + verified.
    expect((await find({ package: 'acme-pay-sdk' }, undefined))[0]?.product_id).toBe(p.id);
  });

  it('never matches pending products or unverified claims, signed in or out', async () => {
    const created = await api('POST', '/api/v1/products', web(lena), { slug: SLUG, name: 'Acme Pay', builderAgent: lena.agentHandle });
    await api('POST', `/api/v1/products/${created.body.id}/claims`, web(lena), { kind: 'npm', value: 'acme-pay-sdk' });
    for (const auth of [agent(vivan), agent(mo), undefined]) {
      const r = await callTool(env, 'find_builder', auth, { package: 'acme-pay-sdk' });
      expect(r.body.output.builders).toEqual([]);
    }
  });

  it('extracts package-like tokens from errors without keeping the error', () => {
    expect(errorTokens('at node_modules/@acme/pay/index.js')).toEqual(expect.arrayContaining(['@acme/pay', 'pay', 'node_modules']));
  });
});

describe('ask_builder and the builder approval queue', () => {
  it('opens a support thread and delivers the question to the builder inbox as a customer, never waking', async () => {
    await activeProduct();
    const res = await ask(vivan, 'Why does constructEvent reject a valid webhook signature?', {
      context: { stack: ['node', 'express'], package_version: '2.1.0', error_signature: 'SignatureVerificationError: No signatures found' },
    });
    expect(res.body.ok).toBe(true);
    const out = AskBuilderOutput.parse(res.body.output);
    expect(out).toMatchObject({ state: 'delivered', builder_presence: 'away', reply_policy: 'builder_approves' });
    expect(Date.parse(out.expected_reply_by!) - Date.now()).toBeGreaterThan(110 * 60_000);

    const th = await env.db.query<{ kind: string; state: string; team_id: string; subject: string; product_id: string }>(
      `select kind, state, team_id, subject, product_id from public.threads where id = $1`, [out.thread_id.slice(2)]);
    expect(th.rows[0]).toMatchObject({ kind: 'support', state: 'open', team_id: teamId, subject: 'Question about Acme Pay' });
    const roles = await env.db.query<{ p_id: string; role: string }>(`select p_id, role from public.thread_participants where thread_id = $1 order by role`, [out.thread_id.slice(2)]);
    expect(roles.rows).toEqual([{ p_id: lena.agentId, role: 'builder' }, { p_id: vivan.agentId, role: 'customer' }]);
    const d = await env.db.query<{ path: string; recipient_agent_id: string }>(`select path, recipient_agent_id from public.message_deliveries`);
    expect(d.rows).toEqual([{ path: 'inbox', recipient_agent_id: lena.agentId }]);
    expect(env.bus.events.filter((e) => e.type === 'message.new').every((e) => e.payload.wake === false)).toBe(true);
    expect((await msgState(out.message_id))).toMatchObject({ state: 'delivered' });

    const inbox = await inboxOf(lena);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({ kind: 'support', from: { agent: vivan.agentHandle, relationship: 'customer' } });
    expect(bodyOf(inbox.messages[0]!)).toContain('[context] stack: node, express · version: 2.1.0');
    expect(inbox.threads[0]?.participants[0]).toMatchObject({ handle: vivan.agentHandle, relationship: 'customer' });
    expect((await inboxOf(vivan)).messages).toHaveLength(0);

    // A second question reuses the thread; the same idempotency key replays.
    const again = await callTool(env, 'ask_builder', agent(vivan), { product: SLUG, question: 'Does v2 change the tolerance?', idempotency_key: 'same-key-001' });
    const replay = await callTool(env, 'ask_builder', agent(vivan), { product: SLUG, question: 'Does v2 change the tolerance?', idempotency_key: 'same-key-001' });
    expect(again.body.output.thread_id).toBe(out.thread_id);
    expect(replay.body.output.message_id).toBe(again.body.output.message_id);
    expect((await env.db.query(`select 1 from public.messages`)).rowCount).toBe(2);

    // Follow-ups asking to wake still arrive next turn only.
    const wake = await callTool(env, 'send_message', agent(vivan), { to: out.thread_id, body: 'Any update?', intent: 'question', urgency: 'wake', idempotency_key: key() });
    expect(wake.body.output).toMatchObject({ state: 'delivered', delivery: { path: 'inbox', note: 'next_turn' } });
  });

  it('holds questions with code or secrets (strict outbound DLP), and refuses unknown products', async () => {
    await activeProduct();
    const code = await ask(vivan, "My handler:\nimport { Acme } from 'acme-pay-sdk';\nconst acme = new Acme(key);\nfunction verify(req) {\n  return acme.webhooks.constructEvent(req.body, sig, secret);\n}");
    expect(code.body.output.state).toBe('held_for_sender');
    const secret = await ask(vivan, `It fails with my token ghp_${'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'}`);
    expect(secret.body.output.state).toBe('held_for_sender');
    expect((await env.db.query(`select 1 from public.message_deliveries`)).rowCount).toBe(0);
    expect((await inboxOf(lena)).messages).toHaveLength(0);
    const missing = await callTool(env, 'ask_builder', agent(vivan), { product: 'nope-product', question: 'hi', idempotency_key: key() });
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect((await callTool(env, 'ask_builder', undefined, { product: SLUG, question: 'hi', idempotency_key: key() })).status).toBe(401);
  });

  it('queues a builder reply for the builder\'s human; approve with edits delivers the edited text to the customer', async () => {
    await activeProduct();
    const q = AskBuilderOutput.parse((await ask(vivan, 'Why does constructEvent reject a valid signature?')).body.output);
    const reply = await send(lena, q.thread_id, 'Pass the raw request body, not the parsed JSON. See the webhooks guide.');
    expect(reply.body.output).toMatchObject({ state: 'request_pending', delivery: { path: 'owner_notification', note: 'awaiting_human_accept' } });

    const rv = await env.db.query<{ id: string; owner_user_id: string; agent_id: string; summary: string; ref_id: string }>(
      `select id, owner_user_id, agent_id, summary, ref_id from public.review_items where kind = 'builder_reply'`);
    expect(rv.rows[0]).toMatchObject({ owner_user_id: lena.userId, agent_id: lena.agentId, summary: 'Your agent drafted a reply to a customer', ref_id: reply.body.output.message_id });
    // Nothing reaches the customer: not the agent, and not the customer's human on the web (9006).
    expect((await inboxOf(vivan)).messages).toHaveLength(0);
    const seen = ThreadDetail.parse((await api('GET', `/api/v1/threads/${q.thread_id}/messages`, web(vivan))).body);
    expect(seen.messages.map((m) => m.id)).toEqual([q.message_id]);
    expect(seen.thread.product).toMatchObject({ slug: SLUG, name: 'Acme Pay' });

    // The builder's human sees the question and the draft.
    const rid = `rv_${rv.rows[0]!.id}`;
    const detail = BuilderReplyReview.parse((await api('GET', `/api/v1/review/${rid}`, web(lena))).body);
    expect(detail.question.id).toBe(q.message_id);
    expect(detail.question.trust).toBe('customer');
    expect(detail.draft).toMatchObject({ id: reply.body.output.message_id, state: 'request_pending' });
    expect(detail.thread.kind).toBe('support');
    expect((await api('GET', `/api/v1/review/${rid}`, web(vivan))).status).toBe(404);

    const edited = 'Pass the raw request body (express.raw) to constructEvent, not the parsed JSON.';
    const dec = await api('POST', `/api/v1/review/${rid}/decision`, web(lena), { decision: 'approve', edits: { body: edited } });
    expect(dec.status).toBe(200);
    await env.deps.jobs.drain();
    expect(await msgState(reply.body.output.message_id)).toEqual({ state: 'delivered', body: edited });
    const inbox = await inboxOf(vivan);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({ kind: 'support', from: { agent: lena.agentHandle, relationship: 'stranger' } });
    expect(bodyOf(inbox.messages[0]!)).toBe(edited);
    expect((await env.db.query(`select path from public.message_deliveries where recipient_agent_id = $1`, [vivan.agentId])).rows).toEqual([{ path: 'inbox' }]);
  });

  it('reject delivers nothing; an edit with a secret is refused at decision time, and held by the worker', async () => {
    await activeProduct();
    const q = AskBuilderOutput.parse((await ask(vivan, 'How do I rotate the signing secret?')).body.output);
    const a = await send(lena, q.thread_id, 'Rotate it in the dashboard under Webhooks.');
    const b = await send(lena, q.thread_id, 'Then update your environment and redeploy.');
    const items = (await env.db.query<{ id: string; ref_id: string }>(`select id, ref_id from public.review_items where kind = 'builder_reply' order by created_at`)).rows;
    const idOf = (m: string) => `rv_${items.find((x) => x.ref_id === m)!.id}`;
    expect((await api('POST', `/api/v1/review/${idOf(a.body.output.message_id)}/decision`, web(lena), { decision: 'reject' })).status).toBe(200);
    const leaky = `Use this key: ghp_${'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'}`;
    expect((await api('POST', `/api/v1/review/${idOf(b.body.output.message_id)}/decision`, web(lena), {
      decision: 'approve', edits: { body: leaky },
    })).status).toBe(400);
    await env.deps.jobs.drain();
    expect((await msgState(b.body.output.message_id)).state).toBe('request_pending');
    // The worker holds it too (a job enqueued before the precheck, or another caller).
    const { applyBuilderReplyDecision } = await import('./index.js');
    expect(await applyBuilderReplyDecision(env.deps, b.body.output.message_id, 'approve', { body: leaky })).toBe('held_for_sender');
    expect((await msgState(a.body.output.message_id)).state).toBe('rejected');
    const held = await msgState(b.body.output.message_id);
    expect(held.state).toBe('held_for_sender');
    expect(held.body).toBe('Then update your environment and redeploy.');
    expect((await inboxOf(vivan)).messages).toHaveLength(0);
  });

  it('auto_send delivers builder replies directly; bug reports become builder tasks', async () => {
    const p = await activeProduct('auto_send');
    const q = AskBuilderOutput.parse((await ask(vivan, 'Is the 300 s tolerance configurable?')).body.output);
    expect(q.reply_policy).toBe('auto_send');
    const r = await send(lena, q.thread_id, 'Yes: pass tolerance in seconds as the fourth argument.');
    expect(r.body.output).toMatchObject({ state: 'delivered', delivery: { path: 'inbox', note: 'next_turn' } });
    expect((await env.db.query(`select 1 from public.review_items where kind = 'builder_reply'`)).rowCount).toBe(0);
    expect(bodyOf((await inboxOf(vivan)).messages[0]!)).toContain('fourth argument');

    const bug = await send(vivan, q.thread_id, 'The tolerance argument is ignored in 2.1.0 when it is zero.', 'bug_report');
    expect(bug.body.output.state).toBe('delivered');
    const tasks = await env.db.query<{ product_id: string; thread_id: string; source_message_id: string; state: string }>(
      `select product_id, thread_id, source_message_id, state from public.builder_tasks`);
    expect(tasks.rows).toEqual([{ product_id: p.id.slice(2), thread_id: q.thread_id.slice(2), source_message_id: bug.body.output.message_id.slice(2), state: 'open' }]);
    // A suspended product takes no new questions or follow-ups.
    await api('PATCH', `/api/v1/products/${p.id}`, web(lena), { status: 'suspended' });
    expect((await ask(vivan, 'Still there?')).body.error.code).toBe('NOT_FOUND');
    expect((await send(vivan, q.thread_id, 'Still there?', 'question')).body.output.state).toBe('rejected');
  });

  it('composes the context line within the cross-owner limit', () => {
    const long = 'x'.repeat(990);
    expect(composeQuestion({ product: SLUG, question: long, idempotency_key: 'k-12345678', context: { error_signature: 'E'.repeat(300) } })).toBe(long);
    const s = composeQuestion({ product: SLUG, question: 'q', idempotency_key: 'k-12345678', context: { package_version: '1.0.0' } });
    expect(s).toBe('q\n\n[context] version: 1.0.0');
  });
});

describe('support routing follows the product\'s current builder', () => {
  const customerGate = () => env.db.query(
    `insert into public.dm_permissions (owner_user_id, subject_kind, subject_id, policy) values ($1, 'relationship', 'customer', 'request')`, [lena.userId]);
  const reviewId = async (kind: string, ref: string) =>
    `rv_${(await env.db.query<{ id: string }>(`select id from public.review_items where kind = $1 and ref_id = $2`, [kind, ref])).rows[0]!.id}`;

  it('moves customer messages to a new builder, and stops a replaced or unset builder (I4, I5)', async () => {
    const p = await activeProduct();
    const q = AskBuilderOutput.parse((await ask(vivan, 'Why does constructEvent reject a valid signature?')).body.output);
    const draft = await send(lena, q.thread_id, 'Pass the raw request body to constructEvent.');
    expect(draft.body.output.state).toBe('request_pending');

    expect((await api('PATCH', `/api/v1/products/${p.id}`, web(lena), { builderAgent: mo.agentHandle })).status).toBe(200);
    const roles = await env.db.query<{ p_id: string; role: string }>(`select p_id, role from public.thread_participants where thread_id = $1 order by role`, [q.thread_id.slice(2)]);
    expect(roles.rows).toEqual([{ p_id: mo.agentId, role: 'builder' }, { p_id: vivan.agentId, role: 'customer' }]);

    // The customer's follow-up reaches the new builder only.
    const follow = await send(vivan, q.thread_id, 'Is the tolerance configurable?', 'question');
    expect(follow.body.output.state).toBe('delivered');
    expect((await inboxOf(mo)).messages.map((m) => m.id)).toEqual([follow.body.output.message_id]);
    expect((await env.db.query(`select 1 from public.message_deliveries where recipient_agent_id = $1`, [lena.agentId])).rowCount).toBe(1);

    // The replaced builder's pending draft can no longer be approved, and the worker declines it anyway.
    const rid = await reviewId('builder_reply', draft.body.output.message_id);
    const dec = await api('POST', `/api/v1/review/${rid}/decision`, web(lena), { decision: 'approve' });
    expect(dec.status).toBe(400);
    expect(dec.body.error.message).toContain('no longer its builder');
    expect((await env.db.query<{ state: string }>(`select state from public.review_items where id = $1`, [rid.slice(3)])).rows[0]!.state).toBe('pending');
    const { applyBuilderReplyDecision } = await import('./index.js');
    expect(await applyBuilderReplyDecision(env.deps, draft.body.output.message_id, 'approve')).toBe('rejected');
    expect((await inboxOf(vivan)).messages).toHaveLength(0);

    // Its new messages are not routed either (it left the thread).
    const late = await send(lena, q.thread_id, 'Also check your clock skew.');
    expect(late.body.error.code).toBe('NOT_FOUND');
    expect((await inboxOf(vivan)).messages).toHaveLength(0);

    // No builder agent at all: follow-ups go nowhere, even though the product stays active.
    expect((await api('PATCH', `/api/v1/products/${p.id}`, web(lena), { builderAgent: null })).status).toBe(200);
    expect((await send(vivan, q.thread_id, 'Anyone there?', 'question')).body.output.state).toBe('rejected');
    expect((await env.db.query(`select 1 from public.message_deliveries`)).rowCount).toBe(2);
    expect((await env.db.query(`select 1 from public.thread_participants where thread_id = $1 and role = 'builder'`, [q.thread_id.slice(2)])).rowCount).toBe(0);
  });

  it('declines a draft approved after the product was suspended', async () => {
    const p = await activeProduct();
    const q = AskBuilderOutput.parse((await ask(vivan, 'How do I rotate the signing secret?')).body.output);
    const draft = await send(lena, q.thread_id, 'Rotate it in the dashboard under Webhooks.');
    const rid = await reviewId('builder_reply', draft.body.output.message_id);
    await api('PATCH', `/api/v1/products/${p.id}`, web(lena), { status: 'suspended' });
    expect((await api('POST', `/api/v1/review/${rid}/decision`, web(lena), { decision: 'approve' })).status).toBe(400);
    const { applyBuilderReplyDecision } = await import('./index.js');
    expect(await applyBuilderReplyDecision(env.deps, draft.body.output.message_id, 'approve')).toBe('rejected');
    expect((await inboxOf(vivan)).messages).toHaveLength(0);
  });

  it('refuses an over-long or code-carrying edit before deciding (nothing shows as sent)', async () => {
    await activeProduct();
    const q = AskBuilderOutput.parse((await ask(vivan, 'Is there a sandbox mode?')).body.output);
    const draft = await send(lena, q.thread_id, 'Yes: use the test keys from the dashboard.');
    const rid = await reviewId('builder_reply', draft.body.output.message_id);
    const long = await api('POST', `/api/v1/review/${rid}/decision`, web(lena), { decision: 'approve', edits: { body: 'y'.repeat(1001) } });
    expect(long.status).toBe(400);
    expect(long.body.error.message).toContain('1000 characters');
    const secret = await api('POST', `/api/v1/review/${rid}/decision`, web(lena), { decision: 'approve', edits: { body: `Use ghp_${'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'}` } });
    expect(secret.status).toBe(400);
    expect((await env.db.query<{ state: string }>(`select state from public.review_items where id = $1`, [rid.slice(3)])).rows[0]!.state).toBe('pending');
    expect((await api('POST', `/api/v1/review/${rid}/decision`, web(lena), { decision: 'approve', edits: { body: 'Yes: use the test-mode keys.' } })).status).toBe(200);
  });

  it('routes human comments by side: the customer\'s human like a customer, the builder\'s human straight to the customer', async () => {
    const p = await activeProduct();
    const q = AskBuilderOutput.parse((await ask(vivan, 'Does v2 change the webhook tolerance?')).body.output);
    const fromCustomer = await api('POST', `/api/v1/threads/${q.thread_id}/comment`, web(vivan), { body: 'Adding: we run on Node 22.' });
    expect(fromCustomer.status).toBe(200);
    expect(fromCustomer.body.state).toBe('delivered');
    const cv = await env.db.query<{ content_class: string }>(`select content_class from public.verdicts where content_id = $1`, [fromCustomer.body.id]);
    expect(cv.rows[0]!.content_class).toBe('dm_stranger');
    expect((await env.db.query<{ recipient_agent_id: string }>(`select recipient_agent_id from public.message_deliveries where message_id = $1`, [fromCustomer.body.id.slice(2)])).rows)
      .toEqual([{ recipient_agent_id: lena.agentId }]);

    const fromBuilder = await api('POST', `/api/v1/threads/${q.thread_id}/comment`, web(lena), { body: 'No, the tolerance is still 300 seconds.' });
    expect(fromBuilder.body.state).toBe('delivered');
    const bv = await env.db.query<{ content_class: string }>(`select content_class from public.verdicts where content_id = $1`, [fromBuilder.body.id]);
    expect(bv.rows[0]!.content_class).toBe('builder_answer');
    expect(bodyOf((await inboxOf(vivan)).messages[0]!)).toContain('300 seconds');

    // A suspended product takes no comments, and the builder owner's deny holds for the customer's human too.
    await api('PATCH', `/api/v1/products/${p.id}`, web(lena), { status: 'suspended' });
    expect((await api('POST', `/api/v1/threads/${q.thread_id}/comment`, web(vivan), { body: 'Hello?' })).body.state).toBe('rejected');
    await api('PATCH', `/api/v1/products/${p.id}`, web(lena), { status: 'active' });
    await env.db.query(`insert into public.dm_permissions (owner_user_id, subject_kind, subject_id, policy) values ($1, 'user', $2, 'deny')`, [lena.userId, vivan.userId]);
    expect((await api('POST', `/api/v1/threads/${q.thread_id}/comment`, web(vivan), { body: 'Hello again?' })).body.state).toBe('rejected');
    expect((await inboxOf(lena)).messages).toHaveLength(2);
  });

  it('makes a builder task when a gated bug report is accepted, and asks never stack up request threads', async () => {
    await activeProduct();
    await customerGate();
    const first = AskBuilderOutput.parse((await ask(vivan, 'Is the tolerance argument honoured?')).body.output);
    expect(first.state).toBe('request_pending');
    const again = await ask(vivan, 'Hello? Is the tolerance argument honoured?');
    expect(again.body.error.code).toBe('DM_NOT_PERMITTED');
    expect((await env.db.query(`select 1 from public.threads where kind = 'support'`)).rowCount).toBe(1);
    expect((await env.db.query(`select 1 from public.review_items where kind = 'dm_request'`)).rowCount).toBe(1);

    // Accepting delivers the question; a bug report, gated again and accepted, becomes a builder task.
    expect((await api('POST', `/api/v1/review/${await reviewId('dm_request', first.message_id)}/decision`, web(lena), { decision: 'approve' })).status).toBe(200);
    await env.deps.jobs.drain();
    expect((await msgState(first.message_id)).state).toBe('delivered');
    const bug = await send(vivan, first.thread_id, 'The tolerance argument is ignored when it is zero.', 'bug_report');
    expect(bug.body.output.state).toBe('request_pending');
    expect((await env.db.query(`select 1 from public.builder_tasks`)).rowCount).toBe(0);
    expect((await api('POST', `/api/v1/review/${await reviewId('dm_request', bug.body.output.message_id)}/decision`, web(lena), { decision: 'approve' })).status).toBe(200);
    await env.deps.jobs.drain();
    const tasks = await env.db.query<{ source_message_id: string }>(`select source_message_id from public.builder_tasks`);
    expect(tasks.rows).toEqual([{ source_message_id: bug.body.output.message_id.slice(2) }]);
    expect((await inboxOf(lena)).messages.map((m) => m.id).sort()).toEqual([first.message_id, bug.body.output.message_id].sort());
  });

  it('finds a PyPI builder from the plugin\'s raw dependency name, with or without an ecosystem', async () => {
    const p = await activeProduct();
    await api('POST', `/api/v1/products/${p.id}/claims`, web(lena), { kind: 'pypi', value: 'acme-pay' });
    expect((await api('POST', `/api/v1/products/${p.id}/claims/verify`, web(lena), { kind: 'pypi', value: 'acme-pay' })).body.verified).toBe(true);
    const find = async (input: Record<string, unknown>) =>
      FindBuilderOutput.parse((await callTool(env, 'find_builder', agent(vivan), input)).body.output).builders;
    expect((await find({ package: 'Acme_Pay' }))[0]).toMatchObject({ product_id: p.id, matched_on: 'package' });
    expect((await find({ package: 'acme.pay', ecosystem: 'pypi' }))[0]?.product_id).toBe(p.id);
    expect(await find({ package: 'Acme_Pay', ecosystem: 'npm' })).toHaveLength(0);
    expect((await find({ error: 'ImportError: cannot import name Client from acme_pay' }))[0]?.matched_on).toBe('error');
  });
});

describe('claim verification fetch', () => {
  it('verifies a large PyPI project document under the PyPI cap', async () => {
    const created = await api('POST', '/api/v1/products', web(lena), { slug: SLUG, name: 'Acme Pay', builderAgent: lena.agentHandle });
    const releases = Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`1.${i}.0`, [{ filename: `acme_pay-1.${i}.0-py3-none-any.whl`, digests: { sha256: 'a'.repeat(64) }, size: 1000 + i, comment_text: 'x'.repeat(700) }]]));
    markers['https://pypi.org/pypi/acme-pay/json'] = { body: { info: { description: `Acme Pay SDK\n\ny-product: ${SLUG}\n` }, releases } };
    expect(JSON.stringify(markers['https://pypi.org/pypi/acme-pay/json']!.body).length).toBeGreaterThan(512 * 1024);
    await api('POST', `/api/v1/products/${created.body.id}/claims`, web(lena), { kind: 'pypi', value: 'acme-pay' });
    expect((await api('POST', `/api/v1/products/${created.body.id}/claims/verify`, web(lena), { kind: 'pypi', value: 'acme-pay' })).body.verified).toBe(true);
  });

  it('refuses private, reserved and NAT64 addresses, and connects only to the address it checked', async () => {
    const { isPrivateAddress, makeGuardedFetch } = await import('./verify.js');
    for (const a of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '100.64.1.1', '198.18.0.1', '192.0.2.1', '0.0.0.0', '224.0.0.1',
      '::1', '::', 'fd00::1', 'fe80::1%en0', '64:ff9b::a00:5', '64:ff9b::10.0.0.5', '::ffff:127.0.0.1', '::ffff:7f00:1', '2002:a00:1::1', '2001:db8::1', 'ff02::1', 'nonsense']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['93.184.216.34', '151.101.1.63', '2606:4700::6810:84e5', '::ffff:93.184.216.34']) expect(isPrivateAddress(a), a).toBe(false);

    // DNS rebinding: one lookup, checked; a private answer fails before any connection.
    let lookups = 0;
    const rebinding = makeGuardedFetch(async () => { lookups++; return [{ address: '10.0.0.5', family: 4 }]; });
    await expect(rebinding('https://rebind.example/.well-known/y.json')).rejects.toThrow(/private address/);
    expect(lookups).toBe(1);
    const mixed = makeGuardedFetch(async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(mixed('https://mixed.example/')).rejects.toThrow(/private address/);
    await expect(makeGuardedFetch()('https://127.0.0.1/')).rejects.toThrow(/private address/);
    await expect(makeGuardedFetch()('https://[::1]/')).rejects.toThrow(/private address/);
    await expect(makeGuardedFetch()('http://example.com/')).rejects.toThrow(/https only/);
  });
});
