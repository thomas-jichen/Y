/**
 * Deterministic offline embedder (dev/tests): hashed bag-of-words + bigrams,
 * FNV-1a buckets with a sign hash, L2-normalized, 384 dims (the DB's vector(384)).
 * Mirrors the packages/retrieval mock design; local so core doesn't depend on
 * its dims constant while that package is being reconciled.
 */
import { createGteEmbedder } from '@paceline/retrieval';
import type { CoreConfig, Embedder } from '../contracts.js';

export const CORE_EMBEDDING_DIMS = 384;

function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function createCoreMockEmbedder(dims = CORE_EMBEDDING_DIMS): Embedder {
  const one = (text: string): number[] => {
    const v = new Array<number>(dims).fill(0);
    const tokens = (text.normalize('NFKC').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
    const tf = new Map<string, number>();
    tokens.forEach((t, i) => {
      tf.set(t, (tf.get(t) ?? 0) + 1);
      const next = tokens[i + 1];
      if (next) tf.set(`${t} ${next}`, (tf.get(`${t} ${next}`) ?? 0) + 0.5);
    });
    for (const [f, n] of tf) {
      const w = 1 + Math.log(Math.max(1, n));
      const bucket = fnv1a(f, 0) % dims;
      const sign = fnv1a(f, 0x9e3779b9) & 1 ? 1 : -1;
      v[bucket] = (v[bucket] ?? 0) + sign * w * (f.includes(' ') ? 0.5 : 1);
    }
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    if (norm === 0) {
      v[0] = 1;
      return v;
    }
    return v.map((x) => x / norm);
  };
  return { dims, embed: async (texts) => texts.map(one) };
}

/**
 * The embedder for this config: gte-small through the Supabase `embed` Edge
 * Function when PACELINE_EMBEDDINGS=gte (PACELINE_EMBED_URL or SUPABASE_URL,
 * plus PACELINE_EMBED_SECRET), the mock otherwise. `gateway` is cut.
 */
export function createCoreEmbedder(
  config: Pick<CoreConfig, 'embeddings' | 'embed'>,
  opts: { fetch?: typeof fetch } = {},
  log?: (level: 'warn', msg: string) => void,
): Embedder {
  if (config.embeddings === 'gte') {
    const url = config.embed?.url;
    const secret = config.embed?.secret;
    if (!url || !secret) throw new Error('PACELINE_EMBEDDINGS=gte needs PACELINE_EMBED_URL (or SUPABASE_URL) and PACELINE_EMBED_SECRET');
    const gte = createGteEmbedder({ url, secret, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    return {
      dims: gte.dims,
      embed: async (texts) => (await gte.embed(texts)).map((v) => Array.from(v)),
    };
  }
  if (config.embeddings === 'gateway') log?.('warn', 'embeddings=gateway is cut; using the mock embedder');
  return createCoreMockEmbedder();
}
