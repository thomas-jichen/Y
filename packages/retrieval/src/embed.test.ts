import { describe, expect, it, vi } from 'vitest';
import {
  EMBEDDING_DIMS,
  EMBED_SECRET_HEADER,
  EmbedError,
  cosineSimilarity,
  createGatewayEmbedder,
  createGteEmbedder,
  createMockEmbedder,
  embedFunctionUrl,
  embedderFromEnv,
  l2Normalize,
} from './index.js';

const norm = (v: Float32Array) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe('createMockEmbedder', () => {
  const e = createMockEmbedder();

  it('is 384-dim and L2-normalized', async () => {
    expect(EMBEDDING_DIMS).toBe(384);
    expect(e.dims).toBe(384);
    expect(e.model).toBe('mock-hash-v1');
    const [v] = await e.embed(['TypeError: Cannot read properties of undefined']);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v?.length).toBe(384);
    expect(norm(v as Float32Array)).toBeCloseTo(1, 5);
  });

  it('is deterministic (bit-identical) and order-preserving', async () => {
    const texts = ['vitest fails with ERR_MODULE_NOT_FOUND', 'next build: Module not found', ''];
    const a = await e.embed(texts);
    const b = await createMockEmbedder().embed([...texts].reverse());
    expect(Array.from(a[0] as Float32Array)).toEqual(Array.from(b[2] as Float32Array));
    expect(Array.from(a[1] as Float32Array)).toEqual(Array.from(b[1] as Float32Array));
    expect(await e.embed([])).toEqual([]);
  });

  it('empty text → unit vector on bucket 0', async () => {
    const [v] = await e.embed(['  ?! ']);
    expect(v?.[0]).toBe(1);
    expect(norm(v as Float32Array)).toBe(1);
  });

  it('puts related error texts closer than unrelated ones', async () => {
    const [q, related, rephrased, unrelated] = await e.embed([
      "TypeError: Cannot read properties of undefined (reading 'map') at UserList.tsx",
      "TypeError: Cannot read properties of undefined (reading 'map') in src/components/UserList.tsx:12:5",
      'cannot read property map of undefined in UserList component',
      'docker compose up fails: port 5432 already allocated by postgres',
    ]);
    const sRelated = cosineSimilarity(q as Float32Array, related as Float32Array);
    const sRephrased = cosineSimilarity(q as Float32Array, rephrased as Float32Array);
    const sUnrelated = cosineSimilarity(q as Float32Array, unrelated as Float32Array);
    expect(sRelated).toBeGreaterThan(0.75);
    expect(sRephrased).toBeGreaterThan(sUnrelated);
    expect(sRelated).toBeGreaterThan(sRephrased);
    expect(sUnrelated).toBeLessThan(0.3);
  });

  it('character trigrams make spelling variants close', async () => {
    const [a, b, c] = await e.embed(['ERR_MODULE_NOT_FOUND', 'ErrModuleNotFound', 'segmentation fault core dumped']);
    expect(cosineSimilarity(a as Float32Array, b as Float32Array)).toBeGreaterThan(0.8);
    expect(cosineSimilarity(a as Float32Array, c as Float32Array)).toBeLessThan(0.3);
  });

  it('different seeds give different spaces', async () => {
    const [a] = await createMockEmbedder({ seed: 1 }).embed(['hello world']);
    const [b] = await createMockEmbedder({ seed: 2 }).embed(['hello world']);
    expect(cosineSimilarity(a as Float32Array, b as Float32Array)).toBeLessThan(0.5);
  });
});

function vec(seed: number): number[] {
  return Array.from({ length: 384 }, (_, i) => Math.sin(i + seed));
}

function okResponse(n: number, start = 0): Response {
  return new Response(JSON.stringify({ model: 'gte-small', dims: 384, embeddings: Array.from({ length: n }, (_, i) => vec(start + i)) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createGteEmbedder (injected fetch, no network)', () => {
  it('POSTs to the embed function with the secret header and normalizes results', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return okResponse(body.input.length);
    });
    const e = createGteEmbedder({ url: 'https://ref.supabase.co/', secret: 's'.repeat(32), fetch: fetch as unknown as typeof globalThis.fetch });
    expect(e.model).toBe('gte-small');
    const out = await e.embed(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(norm(out[0] as Float32Array)).toBeCloseTo(1, 5);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://ref.supabase.co/functions/v1/embed');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)[EMBED_SECRET_HEADER]).toBe('s'.repeat(32));
    expect(JSON.parse(String(init?.body))).toEqual({ input: ['a', 'b'] });
  });

  it('batches by 32, truncates to 8,000 chars and skips empty inputs', async () => {
    const sizes: number[] = [];
    let longest = 0;
    let offset = 0;
    const fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      sizes.push(body.input.length);
      longest = Math.max(longest, ...body.input.map((s) => s.length));
      const r = okResponse(body.input.length, offset);
      offset += body.input.length;
      return r;
    });
    const texts = Array.from({ length: 70 }, (_, i) => (i === 3 ? '   ' : i === 5 ? 'x'.repeat(9000) : `t${i}`));
    const out = await createGteEmbedder({ url: 'https://ref.supabase.co', secret: 'k'.repeat(32), fetch: fetch as never }).embed(texts);
    expect(sizes).toEqual([32, 32, 5]);
    expect(longest).toBe(8000);
    expect(out).toHaveLength(70);
    expect(out[3]?.[0]).toBe(1);
    // Order is preserved around the skipped input: input 4 is the 4th sent (index 3 in the first batch).
    expect(Array.from(out[4] as Float32Array)).toEqual(Array.from(l2Normalize(vec(3))));
  });

  it('retries 5xx and fails fast on 401', async () => {
    let calls = 0;
    const flaky = vi.fn(async () => (++calls < 2 ? new Response('{}', { status: 503 }) : okResponse(1)));
    await expect(createGteEmbedder({ url: 'https://x.co', secret: 'k'.repeat(32), fetch: flaky as never, backoffMs: 1 }).embed(['a'])).resolves.toHaveLength(1);
    expect(flaky).toHaveBeenCalledTimes(2);

    const denied = vi.fn(async () => new Response('{}', { status: 401 }));
    await expect(createGteEmbedder({ url: 'https://x.co', secret: 'k'.repeat(32), fetch: denied as never, backoffMs: 1 }).embed(['a'])).rejects.toMatchObject({
      code: 'EMBED_UNAUTHORIZED',
      retryable: false,
    });
    expect(denied).toHaveBeenCalledTimes(1);

    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(createGteEmbedder({ url: 'https://x.co', secret: 'k'.repeat(32), fetch: down as never, backoffMs: 1, maxRetries: 1 }).embed(['a'])).rejects.toMatchObject({
      code: 'EMBED_UNAVAILABLE',
    });
    expect(down).toHaveBeenCalledTimes(2);
  });

  it('rejects wrong dims or counts without echoing input text', async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ model: 'gte-small', dims: 1536, embeddings: [vec(0)] }), { status: 200 }));
    const err = await createGteEmbedder({ url: 'https://x.co', secret: 'k'.repeat(32), fetch: bad as never })
      .embed(['very private text'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedError);
    expect((err as EmbedError).code).toBe('EMBED_BAD_RESPONSE');
    expect((err as Error).message).not.toContain('private');

    const short = vi.fn(async () => new Response(JSON.stringify({ model: 'gte-small', dims: 384, embeddings: [[1, 2, 3]] }), { status: 200 }));
    await expect(createGteEmbedder({ url: 'https://x.co', secret: 'k'.repeat(32), fetch: short as never }).embed(['a'])).rejects.toMatchObject({ code: 'EMBED_BAD_RESPONSE' });
  });

  it('validates options and resolves the function URL', () => {
    expect(() => createGteEmbedder({ url: '', secret: 'x' })).toThrow(EmbedError);
    expect(() => createGteEmbedder({ url: 'https://x.co', secret: '' })).toThrow(EmbedError);
    expect(embedFunctionUrl('https://x.supabase.co/functions/v1/embed/')).toBe('https://x.supabase.co/functions/v1/embed');
    expect(embedFunctionUrl('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321/functions/v1/embed');
  });
});

describe('embedderFromEnv', () => {
  it('defaults to the mock', () => {
    expect(embedderFromEnv({}).model).toBe('mock-hash-v1');
    expect(embedderFromEnv({ Y_EMBEDDINGS: 'mock' }).model).toBe('mock-hash-v1');
  });
  it('supabase needs SUPABASE_URL and Y_EMBED_SECRET', () => {
    expect(() => embedderFromEnv({ Y_EMBEDDINGS: 'supabase' })).toThrow(/SUPABASE_URL/);
    expect(embedderFromEnv({ Y_EMBEDDINGS: 'supabase', SUPABASE_URL: 'https://x.co', Y_EMBED_SECRET: 'k'.repeat(32) }).model).toBe('gte-small');
  });
  it('gateway is cut', () => {
    expect(() => embedderFromEnv({ Y_EMBEDDINGS: 'gateway' })).toThrow(/NOT_IMPLEMENTED|cut/);
    expect(() => createGatewayEmbedder()).toThrow(EmbedError);
  });
});
