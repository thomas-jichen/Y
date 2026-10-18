import { describe, expect, it } from 'vitest';
import { cosineSimilarity, toPgVector, trigramSimilarity, trigrams } from './index.js';

describe('cosineSimilarity', () => {
  it('basic cases', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [-2, 0])).toBe(-1);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity(new Float32Array([3, 4]), [6, 8])).toBeCloseTo(1, 7);
  });
  it('throws on length mismatch', () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(RangeError);
  });
});

describe('trigramSimilarity (pg_trgm compatible)', () => {
  it('builds pg_trgm trigram sets', () => {
    // SELECT show_trgm('cat') → {"  c"," ca","at ","cat"}
    expect([...trigrams('cat')].sort()).toEqual(['  c', ' ca', 'at ', 'cat']);
    // Words split on non-alphanumerics, lowercased.
    expect([...trigrams('A-b')].sort()).toEqual(['  a', '  b', ' a ', ' b ']);
  });

  it('matches known Postgres similarity() values', () => {
    // SELECT similarity('word', 'two words') → 0.36363637
    expect(trigramSimilarity('word', 'two words')).toBeCloseTo(0.363636, 5);
    // SELECT similarity('cat', 'cat') → 1
    expect(trigramSimilarity('cat', 'CAT')).toBe(1);
    expect(trigramSimilarity('', '')).toBe(0);
    expect(trigramSimilarity('abc', 'xyz')).toBe(0);
  });

  it('error signatures with different paths stay similar', () => {
    const a = "TypeError: Cannot read properties of undefined (reading 'map')";
    const b = "TypeError: Cannot read properties of undefined (reading 'filter')";
    expect(trigramSimilarity(a, b)).toBeGreaterThan(0.6);
  });
});

describe('toPgVector', () => {
  it('formats with shortest round-trip numbers', () => {
    expect(toPgVector([0.1, -2, 0, 1e-7])).toBe('[0.1,-2,0,1e-7]');
    expect(toPgVector(new Float32Array([0.5]))).toBe('[0.5]');
    expect(toPgVector([-0])).toBe('[0]');
    expect(toPgVector([])).toBe('[]');
  });
  it('rejects non-finite values', () => {
    expect(() => toPgVector([Number.NaN])).toThrow(RangeError);
  });
});
