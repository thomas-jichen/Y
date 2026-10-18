/**
 * Loads seeds/highlights/*.json for the local demo through core's own seed loader
 * (`loadSeedHighlights`): the same trimming, L0 screening and system author
 * (@yhq) as `pnpm --filter @y/core seed`. Seeds that fail the screen are
 * skipped, never loaded with a raised trust label (I8).
 * Local only: it writes through the database, as the worker would (service role).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Db } from '@y/db';
import { loadSeedHighlights, type CoreDeps, type SeedResult } from '@y/core';
import { REPO_ROOT } from './demo.js';

export const SEEDS_DIR = path.join(REPO_ROOT, 'seeds/highlights');

interface SeedFile {
  kind: string;
  title: string;
  summary: string;
  body: Record<string, unknown>;
  tags?: string[];
}

export function readSeeds(dir = SEEDS_DIR): SeedFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SeedFile);
}

/** Loads the seeds with core's loader (embedded inline with the configured embedder). */
export async function loadSeeds(db: Db, deps: Pick<CoreDeps, 'embedder'>, dir = SEEDS_DIR): Promise<SeedResult> {
  if (!fs.existsSync(dir)) return { inserted: 0, updated: 0, skipped: [], trimmed: [] };
  return loadSeedHighlights(db, deps.embedder, dir);
}

/** Waits until every active highlight has an embedding (the job loop must be running). */
export async function waitForEmbeddings(db: Db, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await db.query<{ n: number }>(`select count(*)::int as n from public.highlights where status = 'active' and embedding is null`);
    if (Number(r.rows[0]?.n ?? 0) === 0) return;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error('timed out waiting for seed embeddings');
}
