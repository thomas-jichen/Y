/**
 * Similarity helpers (pg_trgm-compatible trigrams) and the pgvector literal.
 */

/** Cosine similarity of two equal-length vectors (0 if either is all zeros). @throws on length mismatch. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new RangeError(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** pg_trgm trigram set: lowercase, split on non-alphanumerics, each word padded `"  w "`. */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  const words = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const w of words) {
    const p = `  ${w} `;
    const cps = Array.from(p);
    for (let i = 0; i + 3 <= cps.length; i++) out.add(cps.slice(i, i + 3).join(''));
  }
  return out;
}

/**
 * pg_trgm-compatible trigram similarity: lowercase, words padded with two
 * leading and one trailing space, trigram sets compared as
 * |A ∩ B| / |A ∪ B|. Matches `similarity()` in Postgres for ASCII input.
 * Two strings without any words → 0.
 */
export function trigramSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** pgvector literal for a vector (`[0.1,0.2,…]`), shortest round-trip number formatting. @throws on non-finite values. */
export function toPgVector(vec: ArrayLike<number>): string {
  const parts: string[] = [];
  for (let i = 0; i < vec.length; i++) {
    const x = vec[i] as number;
    if (!Number.isFinite(x)) throw new RangeError('toPgVector: non-finite value');
    parts.push(String(Object.is(x, -0) ? 0 : x));
  }
  return `[${parts.join(',')}]`;
}
