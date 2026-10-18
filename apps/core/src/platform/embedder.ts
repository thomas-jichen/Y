/**
 * Deterministic offline embedder (dev/tests): hashed bag-of-words + bigrams,
 * FNV-1a buckets with a sign hash, L2-normalized, 384 dims (the DB's vector(384)).
 * Mirrors the packages/retrieval mock design; local so core doesn't depend on
 * its dims constant while that package is being reconciled.
 */
import type { Embedder } from '../contracts.js';

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
