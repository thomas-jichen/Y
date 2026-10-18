/**
 * Gate for the repo's own SQL: every supabase/migrations file must apply on
 * PGlite, and every supabase/tests/*.sql pgTAP file must pass. Files are
 * discovered at collection time, one vitest test per file; an empty or
 * missing folder passes.
 */
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listAppliedMigrations, loadMigrationFiles } from './migrate.js';
import { paths } from './paths.js';
import { formatSqlTestFile, listSqlTestFiles, runSqlTestFile } from './sqltest.js';
import { withTestDb } from './testing.js';

describe('supabase/migrations', () => {
  it('apply cleanly on PGlite (with the local shims)', async () => {
    const files = await loadMigrationFiles(paths.migrationsDir, false);
    await withTestDb(async (db) => {
      const applied = (await listAppliedMigrations(db)).map((m) => m.name);
      expect(applied).toEqual(files.map((f) => f.name));
      // The local shims ran first, so Supabase built-ins exist.
      const { rows } = await db.query<{ ok: boolean }>("select to_regprocedure('auth.uid()') is not null as ok");
      expect(rows[0]!.ok).toBe(true);
    });
  });
});

describe('supabase/tests (pgTAP on PGlite)', () => {
  const files = listSqlTestFiles(paths.sqlTestsDir);

  if (files.length === 0) {
    it('has no SQL test files yet', () => {
      expect(files).toEqual([]);
    });
  }

  for (const file of files) {
    it(basename(file), async () => {
      const result = await runSqlTestFile(file);
      expect(result.ok, `\n${formatSqlTestFile(result)}\n`).toBe(true);
    });
  }
});
