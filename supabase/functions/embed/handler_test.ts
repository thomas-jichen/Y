/**
 * Tests for the embed handler. Run with `deno test supabase/functions/embed`
 * (no network; the model is a deterministic stand-in).
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { createEmbedHandler, EMBEDDING_DIMS, SECRET_HEADER, secretsEqual } from './handler.ts';

const SECRET = 'test-secret-0123456789abcdef';

/** Deterministic unit vector derived from the text length. */
function fakeEmbed(text: string): Promise<number[]> {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  v[text.length % EMBEDDING_DIMS] = 1;
  return Promise.resolve(v);
}

function post(body: unknown, headers: Record<string, string> = { [SECRET_HEADER]: SECRET }): Request {
  return new Request('http://localhost/functions/v1/embed', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const handler = createEmbedHandler({ secret: SECRET, embed: fakeEmbed });

Deno.test('embeds a single string', async () => {
  const res = await handler(post({ input: 'hello' }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.model, 'gte-small');
  assertEquals(body.dims, 384);
  assertEquals(body.embeddings.length, 1);
  assertEquals(body.embeddings[0].length, 384);
});

Deno.test('embeds a batch in input order', async () => {
  const res = await handler(post({ input: ['a', 'bb', 'ccc'] }));
  const body = await res.json();
  assertEquals(body.embeddings.map((v: number[]) => v.indexOf(1)), [1, 2, 3]);
});

Deno.test('rejects a missing or wrong secret', async () => {
  assertEquals((await handler(post({ input: 'x' }, {}))).status, 401);
  assertEquals((await handler(post({ input: 'x' }, { [SECRET_HEADER]: 'nope' }))).status, 401);
  const body = await (await handler(post({ input: 'x' }, {}))).json();
  assertEquals(body.error.code, 'UNAUTHORIZED');
});

Deno.test('fails closed when the secret is not configured', async () => {
  const unconfigured = createEmbedHandler({ secret: undefined, embed: fakeEmbed });
  assertEquals((await unconfigured(post({ input: 'x' }))).status, 500);
  const weak = createEmbedHandler({ secret: 'short', embed: fakeEmbed });
  assertEquals((await weak(post({ input: 'x' }, { [SECRET_HEADER]: 'short' }))).status, 500);
});

Deno.test('validates the body', async () => {
  for (const bad of ['not json', { input: [] }, { input: [1] }, { input: '' }, { text: 'x' }, { input: 'x', extra: 1 }]) {
    const res = await handler(post(bad));
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error.code, 'VALIDATION');
  }
  assertEquals((await handler(post({ input: new Array(33).fill('x') }))).status, 400);
  assertEquals((await handler(post({ input: 'x'.repeat(8001) }))).status, 400);
});

Deno.test('only POST is allowed', async () => {
  const res = await handler(new Request('http://localhost/functions/v1/embed', { method: 'GET' }));
  assertEquals(res.status, 405);
  assertEquals(res.headers.get('allow'), 'POST');
});

Deno.test('model failures and wrong dimensions are errors', async () => {
  const broken = createEmbedHandler({ secret: SECRET, embed: () => Promise.reject(new Error('boom')) });
  const res = await broken(post({ input: 'x' }));
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.retryable, true);
  const wrong = createEmbedHandler({ secret: SECRET, embed: () => Promise.resolve([1, 2, 3]) });
  assertEquals((await wrong(post({ input: 'x' }))).status, 500);
});

Deno.test('secretsEqual compares exactly', async () => {
  assert(await secretsEqual(SECRET, SECRET));
  assert(!(await secretsEqual(SECRET, `${SECRET}x`)));
  assert(!(await secretsEqual('', SECRET)));
});
