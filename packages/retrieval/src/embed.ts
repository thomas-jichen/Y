/**
 * Embedders: the deterministic mock (dev and tests) and gte-small through
 * the Supabase `embed` Edge Function (production). 384 dims everywhere.
 */

/**
 * Embedding width: `vector(384)` columns, gte-small and the mock embedder.
 * Mirrors `EMBEDDING_DIMS` in `@paceline/schema` (hosting contracts).
 */
export const EMBEDDING_DIMS = 384 as const;

/** Production embedding model (Supabase built-in inference). */
export const GTE_EMBEDDING_MODEL = 'gte-small' as const;
/** Model id of {@link createMockEmbedder}. */
export const MOCK_EMBEDDING_MODEL = 'mock-hash-v1' as const;

/** Embed Edge Function path, secret header and limits (mirror `@paceline/schema` hosting contracts). */
export const EMBED_FUNCTION_PATH = '/functions/v1/embed' as const;
export const EMBED_SECRET_HEADER = 'x-paceline-embed-secret' as const;
export const EMBED_MAX_INPUTS = 32;
export const EMBED_MAX_INPUT_CHARS = 8000;

/** An embedder. Vectors are L2-normalized and exactly {@link EMBEDDING_DIMS} long. */
export interface Embedder {
  /** Model id stored next to each embedding (`mock-hash-v1` or `gte-small`). */
  readonly model: string;
  readonly dims: typeof EMBEDDING_DIMS;
  /** Embed in input order. An empty input array resolves to `[]`. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/** L2-normalize in place-free fashion; an all-zero vector becomes the unit vector on bucket 0. */
export function l2Normalize(vec: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += (vec[i] as number) ** 2;
  const out = new Float32Array(vec.length);
  if (!(sum > 0) || !Number.isFinite(sum)) {
    if (out.length > 0) out[0] = 1;
    return out;
  }
  const norm = Math.sqrt(sum);
  for (let i = 0; i < vec.length; i++) out[i] = (vec[i] as number) / norm;
  return out;
}

/* ================================================================ mock */

/** Options for {@link createMockEmbedder}. */
export interface MockEmbedderOptions {
  /** Hash seed (default 0); different seeds give unrelated spaces. */
  seed?: number;
}

const encoder = new TextEncoder();

/** FNV-1a 32-bit over the UTF-8 bytes of `s`, mixed with `seed`. */
export function fnv1a(s: string, seed = 0): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (const b of encoder.encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Word tokens used by the mock embedder (camelCase split, lowercase, NFKC, runs of `[a-z0-9]` of length ≥ 2). */
export function mockTokens(text: string): string[] {
  const t = text
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  return (t.match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 2);
}

const TRIGRAM_WEIGHT = 0.3;
const BIGRAM_WEIGHT = 0.5;

/**
 * Deterministic, offline embedder (`model: 'mock-hash-v1'`): a signed hashed
 * bag of words plus character trigrams, so related error texts land close.
 * 1. tokens = {@link mockTokens}; features: each word (`w:`), adjacent-word
 *    bigrams (`b:`, × 0.5) and each word's character trigrams padded with one
 *    space each side (`t:`, × 0.3);
 * 2. each feature hashes (FNV-1a 32-bit, seeded) to a bucket in [0, 384) and
 *    a sign (±1) from a second hash; weight = (1 + ln tf) × kind factor;
 * 3. L2-normalize. Text with no tokens → the unit vector on bucket 0.
 * Same input → bit-identical output across runs and platforms.
 */
export function createMockEmbedder(opts?: MockEmbedderOptions): Embedder {
  const seed = (opts?.seed ?? 0) >>> 0;
  const signSeed = (seed ^ 0x9e3779b9) >>> 0;
  const embedOne = (text: string): Float32Array => {
    const words = mockTokens(text);
    const tf = new Map<string, number>();
    const add = (f: string) => tf.set(f, (tf.get(f) ?? 0) + 1);
    for (let i = 0; i < words.length; i++) {
      const w = words[i] as string;
      add(`w:${w}`);
      if (i > 0) add(`b:${words[i - 1]} ${w}`);
      const padded = ` ${w} `;
      for (let j = 0; j + 3 <= padded.length; j++) add(`t:${padded.slice(j, j + 3)}`);
    }
    const acc = new Float64Array(EMBEDDING_DIMS);
    // Iterate features in sorted order so float summation order is fixed.
    for (const f of [...tf.keys()].sort()) {
      const count = tf.get(f) as number;
      const kind = f[0] === 'w' ? 1 : f[0] === 'b' ? BIGRAM_WEIGHT : TRIGRAM_WEIGHT;
      const bucket = fnv1a(f, seed) % EMBEDDING_DIMS;
      const sign = fnv1a(f, signSeed) & 1 ? -1 : 1;
      acc[bucket] = (acc[bucket] as number) + sign * kind * (1 + Math.log(count));
    }
    return l2Normalize(acc);
  };
  return {
    model: MOCK_EMBEDDING_MODEL,
    dims: EMBEDDING_DIMS,
    embed: async (texts) => texts.map(embedOne),
  };
}

/* ======================================================= gte (Supabase) */

/** Options for {@link createGteEmbedder}. */
export interface GteEmbedderOptions {
  /** Supabase project URL (`https://<ref>.supabase.co`) or the full function URL ending in `/functions/v1/embed`. */
  url: string;
  /** `PACELINE_EMBED_SECRET`. */
  secret: string;
  /** Injected fetch (default `globalThis.fetch`). */
  fetch?: typeof fetch;
  /** Inputs per request (default and max 32). */
  batchSize?: number;
  /** Retries on 429/5xx/network errors (default 2). */
  maxRetries?: number;
  /** Per-request timeout (default 15 s). */
  timeoutMs?: number;
  /** Backoff base (default 250 ms, doubled per attempt). */
  backoffMs?: number;
}

/** Error raised by {@link createGteEmbedder}; `code`/`retryable` follow the `ErrorBody` shape. */
export class EmbedError extends Error {
  constructor(
    readonly code: 'EMBED_UNAUTHORIZED' | 'EMBED_VALIDATION' | 'EMBED_UNAVAILABLE' | 'EMBED_BAD_RESPONSE' | 'NOT_IMPLEMENTED',
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EmbedError';
  }
}

/** Resolve the function URL from a project URL or a full function URL. */
export function embedFunctionUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith(EMBED_FUNCTION_PATH) ? trimmed : `${trimmed}${EMBED_FUNCTION_PATH}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * gte-small embedder calling the Supabase `embed` Edge Function
 * (`POST <url>/functions/v1/embed`, header `x-paceline-embed-secret`, body
 * `{"input": string[]}` ≤ 32 inputs of ≤ 8,000 chars). Inputs are truncated
 * to 8,000 chars; empty/whitespace inputs are not sent and get the unit
 * vector on bucket 0. Every returned vector is checked to be 384 long and
 * re-normalized. Retries 429/5xx/network errors with exponential backoff.
 * Error messages never include input text. Network: core/worker only; tests
 * inject `fetch`.
 */
export function createGteEmbedder(opts: GteEmbedderOptions): Embedder {
  if (!opts.url) throw new EmbedError('EMBED_VALIDATION', 'createGteEmbedder: url is required', false);
  if (!opts.secret) throw new EmbedError('EMBED_VALIDATION', 'createGteEmbedder: secret is required', false);
  const endpoint = embedFunctionUrl(opts.url);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const batchSize = Math.max(1, Math.min(EMBED_MAX_INPUTS, opts.batchSize ?? EMBED_MAX_INPUTS));
  const maxRetries = Math.max(0, opts.maxRetries ?? 2);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const backoffMs = opts.backoffMs ?? 250;

  const callOnce = async (inputs: string[]): Promise<Float32Array[]> => {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [EMBED_SECRET_HEADER]: opts.secret },
        body: JSON.stringify({ input: inputs }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new EmbedError('EMBED_UNAVAILABLE', 'embed function unreachable', true);
    }
    if (res.status === 401 || res.status === 403) throw new EmbedError('EMBED_UNAUTHORIZED', `embed function rejected the secret (${res.status})`, false, res.status);
    if (res.status === 429 || res.status >= 500) throw new EmbedError('EMBED_UNAVAILABLE', `embed function unavailable (${res.status})`, true, res.status);
    if (!res.ok) throw new EmbedError('EMBED_VALIDATION', `embed function rejected the request (${res.status})`, false, res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new EmbedError('EMBED_BAD_RESPONSE', 'embed function returned invalid JSON', false, res.status);
    }
    const b = body as { dims?: unknown; embeddings?: unknown };
    if (b.dims !== EMBEDDING_DIMS || !Array.isArray(b.embeddings) || b.embeddings.length !== inputs.length) {
      throw new EmbedError('EMBED_BAD_RESPONSE', 'embed function returned an unexpected shape', false, res.status);
    }
    return b.embeddings.map((v: unknown) => {
      if (!Array.isArray(v) || v.length !== EMBEDDING_DIMS || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        throw new EmbedError('EMBED_BAD_RESPONSE', `embed function returned a vector that is not ${EMBEDDING_DIMS} finite numbers`, false, res.status);
      }
      return l2Normalize(v as number[]);
    });
  };

  const call = async (inputs: string[]): Promise<Float32Array[]> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await callOnce(inputs);
      } catch (e) {
        if (!(e instanceof EmbedError) || !e.retryable || attempt >= maxRetries) throw e;
        await sleep(backoffMs * 2 ** attempt);
      }
    }
  };

  return {
    model: GTE_EMBEDDING_MODEL,
    dims: EMBEDDING_DIMS,
    async embed(texts) {
      const out: Float32Array[] = new Array(texts.length);
      const pending: { i: number; text: string }[] = [];
      texts.forEach((t, i) => {
        const text = t.slice(0, EMBED_MAX_INPUT_CHARS);
        if (text.trim().length === 0) out[i] = l2Normalize(new Float32Array(EMBEDDING_DIMS));
        else pending.push({ i, text });
      });
      for (let s = 0; s < pending.length; s += batchSize) {
        const batch = pending.slice(s, s + batchSize);
        const vecs = await call(batch.map((p) => p.text));
        batch.forEach((p, j) => {
          out[p.i] = vecs[j] as Float32Array;
        });
      }
      return out;
    },
  };
}

/** Gateway embeddings were cut (384-dim gte-small via Supabase replaced them). Always throws `NOT_IMPLEMENTED`. */
export function createGatewayEmbedder(_opts?: unknown): Embedder {
  throw new EmbedError('NOT_IMPLEMENTED', 'gateway embeddings are cut; use createGteEmbedder (PACELINE_EMBEDDINGS=supabase)', false);
}

/**
 * Pick an embedder from env: `PACELINE_EMBEDDINGS=supabase` (or `gte`) →
 * {@link createGteEmbedder} with `SUPABASE_URL` and `PACELINE_EMBED_SECRET`
 * (throws when either is missing); `gateway` → throws `NOT_IMPLEMENTED`;
 * anything else (including unset and `mock`) → {@link createMockEmbedder}.
 */
export function embedderFromEnv(env: Record<string, string | undefined> = process.env): Embedder {
  const mode = (env.PACELINE_EMBEDDINGS ?? 'mock').trim().toLowerCase();
  if (mode === 'supabase' || mode === 'gte') {
    const url = env.SUPABASE_URL;
    const secret = env.PACELINE_EMBED_SECRET;
    if (!url || !secret) throw new EmbedError('EMBED_VALIDATION', 'PACELINE_EMBEDDINGS=supabase needs SUPABASE_URL and PACELINE_EMBED_SECRET', false);
    return createGteEmbedder({ url, secret });
  }
  if (mode === 'gateway') return createGatewayEmbedder();
  return createMockEmbedder();
}
