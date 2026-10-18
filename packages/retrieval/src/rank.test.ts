import { describe, expect, it } from 'vitest';
import { RRF_K, THRESHOLDS, feedScore, finalScore, passesThreshold, rrfFuse, tagOverlap } from './index.js';

describe('rrfFuse', () => {
  it('sums 1/(k+rank) across lists with 1-based ranks', () => {
    const fused = rrfFuse([
      ['a', 'b', 'c'],
      ['b', 'a'],
      ['c'],
    ]);
    const byId = Object.fromEntries(fused.map((f) => [f.id, f]));
    expect(byId.a?.rrf).toBeCloseTo(1 / 61 + 1 / 62, 15);
    expect(byId.b?.rrf).toBeCloseTo(1 / 62 + 1 / 61, 15);
    expect(byId.c?.rrf).toBeCloseTo(1 / 63 + 1 / 61, 15);
    expect(byId.a?.ranks).toEqual([1, 2, null]);
    expect(byId.c?.ranks).toEqual([3, null, 1]);
  });

  it('orders by rrf desc, then best rank, then id', () => {
    expect(rrfFuse([['x', 'y'], ['y', 'x']]).map((f) => f.id)).toEqual(['x', 'y']);
    expect(rrfFuse([['b'], ['a']]).map((f) => f.id)).toEqual(['a', 'b']);
    expect(rrfFuse([['a', 'b', 'c'], ['c']]).map((f) => f.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps the first occurrence of duplicates and handles empty input', () => {
    const [only] = rrfFuse([['a', 'a', 'b']]);
    expect(only?.ranks).toEqual([1]);
    expect(rrfFuse([['a', 'a', 'b']]).find((f) => f.id === 'b')?.ranks).toEqual([2]);
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[], []])).toEqual([]);
  });

  it('honours a custom k', () => {
    expect(rrfFuse([['a']], 0)[0]?.rrf).toBe(1);
    expect(RRF_K).toBe(60);
  });
});

describe('finalScore', () => {
  const top3 = 3 / 61;
  it('is 1 when ranked first everywhere with perfect quality', () => {
    expect(finalScore({ rrf: top3, listCount: 3, quality: 1 })).toBeCloseTo(1, 12);
  });

  it('weights quality between 0.75 and 1', () => {
    expect(finalScore({ rrf: top3, listCount: 3, quality: 0 })).toBeCloseTo(0.75, 12);
    expect(finalScore({ rrf: top3, listCount: 3, quality: 0.5 })).toBeCloseTo(0.875, 12);
  });

  it('blends cosine when known', () => {
    expect(finalScore({ rrf: top3, listCount: 3, quality: 1, cosine: 0.6 })).toBeCloseTo(0.8, 12);
    expect(finalScore({ rrf: 0, listCount: 3, quality: 1, cosine: -0.4 })).toBe(0);
  });

  it('demotes other-team items and low stack overlap; unknown is neutral', () => {
    const base = finalScore({ rrf: top3, listCount: 3, quality: 1 });
    expect(finalScore({ rrf: top3, listCount: 3, quality: 1, sameTeam: true })).toBe(base);
    expect(finalScore({ rrf: top3, listCount: 3, quality: 1, sameTeam: false })).toBeCloseTo(0.9, 12);
    expect(finalScore({ rrf: top3, listCount: 3, quality: 1, stackOverlap: 0 })).toBeCloseTo(0.9, 12);
    expect(finalScore({ rrf: top3, listCount: 3, quality: 1, stackOverlap: 1 })).toBe(base);
  });

  it('stays in [0, 1] for odd inputs', () => {
    expect(finalScore({ rrf: 10, listCount: 1, quality: 5, cosine: 3 })).toBe(1);
    expect(finalScore({ rrf: 0.01, listCount: 0, quality: 0.5 })).toBe(0);
    expect(finalScore({ rrf: Number.NaN, listCount: 2, quality: 0.5 })).toBe(0);
  });

  it('a strong same-team match clears push; a weak one only clears search', () => {
    // Rank 1 in vector + trigram lists, rank 3 in FTS; cosine 0.85; neutral quality.
    const strong = finalScore({ rrf: 2 / 61 + 1 / 63, listCount: 3, quality: 0.5, cosine: 0.85, sameTeam: true, stackOverlap: 1 });
    expect(passesThreshold(strong, 'push')).toBe(true);
    // Rank 10 in a single list, cosine 0.5.
    const weak = finalScore({ rrf: 1 / 70, listCount: 3, quality: 0.5, cosine: 0.5 });
    expect(passesThreshold(weak, 'search')).toBe(true);
    expect(passesThreshold(weak, 'push')).toBe(false);
    expect(THRESHOLDS).toMatchObject({ search: 0.25, push: 0.6 });
  });
});

describe('feedScore / tagOverlap', () => {
  it('tagOverlap is Jaccard', () => {
    expect(tagOverlap(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 12);
    expect(tagOverlap([], [])).toBe(0);
    expect(tagOverlap(['a', 'a'], ['a'])).toBe(1);
    expect(tagOverlap(['A'], ['a'])).toBe(0);
  });

  it('decays with age, rewards overlap and halves near-duplicates', () => {
    expect(feedScore({ baseScore: 1, ageHours: 0, tagOverlap: 1 })).toBe(1);
    expect(feedScore({ baseScore: 1, ageHours: 72, tagOverlap: 1 })).toBeCloseTo(Math.exp(-1), 12);
    expect(feedScore({ baseScore: 1, ageHours: 0, tagOverlap: 0 })).toBe(0.25);
    expect(feedScore({ baseScore: 1, ageHours: 0, tagOverlap: 1, nearDuplicate: true })).toBe(0.5);
  });
});
