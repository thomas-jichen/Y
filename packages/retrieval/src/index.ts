/**
 * @y/retrieval: embeddings and ranking math for search, push and the
 * feed (PLAN §4 "What gets embedded", §8 Search/Feed).
 *
 * Search itself runs in SQL (`api.search_network`, `security invoker`):
 * pgvector `ORDER BY embedding <=> q LIMIT 40`, FTS `ts_rank_cd`, trigram on
 * error signatures, fused with RRF (k = 60). This package provides the same
 * fusion and scoring in TypeScript (for core post-processing, tests and the
 * eval), the embedders, the exact text that gets embedded and query
 * normalization.
 *
 * Embeddings are 384 dimensions (`gte-small` via the Supabase `embed` Edge
 * Function, see `@y/schema` hosting contracts). Tests and dev use
 * {@link createMockEmbedder} (`Y_EMBEDDINGS=mock`, the default).
 *
 * @packageDocumentation
 */
export * from './embed.js';
export * from './text.js';
export * from './rank.js';
export * from './similarity.js';
