/**
 * Fusion and scoring for search, push and the feed (PLAN §8).
 */

/** RRF constant. */
export const RRF_K = 60;

/** A fused result. */
export interface FusedItem {
  id: string;
  /** Σ over lists of 1 / (k + rank), rank 1-based. */
  rrf: number;
  /** 1-based rank in each input list, or null when absent. */
  ranks: (number | null)[];
}

/**
 * Reciprocal-rank fusion. Each list is ids in rank order (duplicates within
 * a list keep the first occurrence). Output sorted by `rrf` desc, ties broken
 * by best single rank, then id ascending. Pure.
 */
export function rrfFuse(lists: readonly (readonly string[])[], k: number = RRF_K): FusedItem[] {
  const byId = new Map<string, FusedItem>();
  lists.forEach((list, li) => {
    const seen = new Set<string>();
    let rank = 0;
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank++;
      let item = byId.get(id);
      if (!item) {
        item = { id, rrf: 0, ranks: lists.map(() => null) };
        byId.set(id, item);
      }
      item.ranks[li] = rank;
      item.rrf += 1 / (k + rank);
    }
  });
  const best = (it: FusedItem) => Math.min(...it.ranks.map((r) => r ?? Number.POSITIVE_INFINITY));
  return [...byId.values()].sort((a, b) => b.rrf - a.rrf || best(a) - best(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Score cut-offs (PLAN §8). */
export const THRESHOLDS = {
  /** Drop search results below this final score. */
  search: 0.25,
  /** Minimum final score for a P2 push. */
  push: 0.6,
  /** Independent rediscovery / near-duplicate (cosine). */
  duplicateCosine: 0.88,
  /** Independent rediscovery (trigram on error signatures). */
  duplicateTrigram: 0.6,
  /** Segment assignment by centroid. */
  segmentCentroid: 0.82,
} as const;

/** Inputs to {@link finalScore}. */
export interface FinalScoreInput {
  /** RRF sum from {@link rrfFuse}. */
  rrf: number;
  /** Number of lists fused (normalizes rrf to [0, 1]). */
  listCount: number;
  /** Highlight quality in [0, 1] (`@paceline/domain` `quality`). */
  quality: number;
  /** Best cosine similarity from the vector list, if known. */
  cosine?: number;
  /** The item's author is on the viewer's team. `false` applies a 0.9 factor; unknown is neutral. */
  sameTeam?: boolean;
  /** Jaccard overlap of the item's and viewer's stack tags in [0, 1] ({@link tagOverlap}); unknown is neutral. */
  stackOverlap?: number;
  k?: number;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/**
 * Final relevance in [0, 1] used against {@link THRESHOLDS}:
 * `base = rrf / (listCount / (k + 1))` (1.0 = ranked first in every list),
 * blended with semantic closeness when known: `rel = cosine === undefined ?
 * base : 0.5·base + 0.5·max(0, cosine)`; then
 * `score = rel × (0.75 + 0.25 × quality) × team × stack`, where
 * `team = sameTeam === false ? 0.9 : 1` and
 * `stack = stackOverlap === undefined ? 1 : 0.9 + 0.1 × stackOverlap`;
 * clamped to [0, 1]. Relevance dominates: context factors only ever demote.
 */
export function finalScore(input: FinalScoreInput): number {
  const k = input.k ?? RRF_K;
  if (!(input.listCount > 0)) return 0;
  const base = clamp01(input.rrf / (input.listCount / (k + 1)));
  const rel = input.cosine === undefined ? base : 0.5 * base + 0.5 * clamp01(input.cosine);
  const team = input.sameTeam === false ? 0.9 : 1;
  const stack = input.stackOverlap === undefined ? 1 : 0.9 + 0.1 * clamp01(input.stackOverlap);
  return clamp01(rel * (0.75 + 0.25 * clamp01(input.quality)) * team * stack);
}

/** Whether a final score clears the cut-off for `search` results or a P2 `push`. */
export function passesThreshold(score: number, use: 'search' | 'push'): boolean {
  return score >= THRESHOLDS[use];
}

/**
 * "For you" feed score: `baseScore × exp(−ageHours / 72) × (0.25 + 0.75 ×
 * tagOverlap) × (1 − 0.5 × nearDuplicate)`, where `tagOverlap` is the Jaccard
 * overlap of stack tags in [0, 1] and `nearDuplicate` ∈ {0, 1}.
 */
export function feedScore(input: { baseScore: number; ageHours: number; tagOverlap: number; nearDuplicate?: boolean }): number {
  const age = Math.max(0, input.ageHours);
  return input.baseScore * Math.exp(-age / 72) * (0.25 + 0.75 * clamp01(input.tagOverlap)) * (input.nearDuplicate ? 0.5 : 1);
}

/** Jaccard overlap of two tag sets (case-sensitive; 0 when both empty). */
export function tagOverlap(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
