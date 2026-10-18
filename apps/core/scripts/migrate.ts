/**
 * `pnpm --filter @y/core migrate`: apply supabase/migrations, then
 * apps/core/migrations, to DATABASE_URL (Y_DB_FLAVOR=supabase) or the
 * local PGlite. Serverless core never migrates on cold start; run this first.
 */
import { createDb, migrate } from '@y/db';
import { migrateCore } from '../src/platform/index.js';

const db = await createDb(process.env);
const log = (line: string) => console.log(`[migrate] ${line}`);
try {
  const r = await migrate(db, { log });
  await migrateCore(db, log);
  console.log(`[migrate] ok (${db.flavor}; applied ${r.applied.length} supabase migration(s))`);
} finally {
  await db.close();
}
