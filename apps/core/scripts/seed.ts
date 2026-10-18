/**
 * `pnpm --filter @y/core seed [dir]`: load seeds/highlights/*.json as
 * public, active, screened highlights by @y (idempotent). Uses the
 * configured embedder (Y_EMBEDDINGS=gte in production). Run migrate first
 * against a remote database; a local PGlite is migrated here.
 */
import { createDb, migrate } from '@y/db';
import { createCoreEmbedder, loadConfig, migrateCore } from '../src/platform/index.js';
import { defaultSeedDir, loadSeedHighlights } from '../src/platform/seed.js';

const config = loadConfig(process.env);
const db = await createDb(process.env);
try {
  if (db.local) {
    await migrate(db);
    await migrateCore(db);
  }
  const dir = process.argv[2] ?? defaultSeedDir();
  const r = await loadSeedHighlights(db, createCoreEmbedder(config), dir);
  console.log(`[seed] ${r.inserted} inserted, ${r.updated} updated, ${r.skipped.length} skipped from ${dir}`);
  for (const s of r.skipped) console.log(`[seed] skipped ${s.file}: ${s.reason}`);
  for (const t of r.trimmed) console.log(`[seed] trimmed ${t.file}: ${t.fields.join(', ')}`);
} finally {
  await db.close();
}
