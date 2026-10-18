/**
 * `smoke:serverless` must stay on its own file-backed PGlite even when the operator's
 * shell exports a production DATABASE_URL (DEPLOY.md step 2 has them do exactly that).
 * The probe URL points at a closed loopback port: if the smoke ever used it, the run
 * would fail with ECONNREFUSED instead of passing.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(CORE, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

describe('smoke-serverless', () => {
  it('ignores an exported DATABASE_URL / Y_DB_FLAVOR and ages only its own session', () => {
    const r = spawnSync(TSX, ['scripts/smoke-serverless.ts'], {
      cwd: CORE,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://probe:probe@127.0.0.1:1/probe',
        DATABASE_LISTEN_URL: 'postgresql://probe:probe@127.0.0.1:1/probe',
        Y_DB_FLAVOR: 'supabase',
      },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).not.toContain('ECONNREFUSED');
    expect(out).not.toContain('FAILED');
    expect(r.status, out).toBe(0);
    expect(out).toMatch(/serverless smoke: \d+ checks passed/);
  }, 150_000);
});
