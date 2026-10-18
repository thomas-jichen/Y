import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findWorkspaceRoot, paths, resolveDataDir } from './paths.js';

describe('paths', () => {
  it('points at the repo layout', () => {
    expect(existsSync(join(paths.repoRoot, 'pnpm-workspace.yaml'))).toBe(true);
    expect(paths.migrationsDir).toBe(join(paths.repoRoot, 'supabase', 'migrations'));
    expect(paths.sqlTestsDir).toBe(join(paths.repoRoot, 'supabase', 'tests'));
    expect(existsSync(paths.localShims)).toBe(true);
    expect(paths.packageDir).toBe(join(paths.repoRoot, 'packages', 'db'));
  });

  it('finds the workspace root from a nested directory', () => {
    expect(findWorkspaceRoot(join(paths.packageDir, 'src'))).toBe(paths.repoRoot);
  });
});

describe('resolveDataDir', () => {
  it('defaults to .pglite at the workspace root, wherever the script runs', () => {
    expect(resolveDataDir(undefined, join(paths.repoRoot, 'apps', 'core'))).toBe(join(paths.repoRoot, '.pglite'));
    expect(resolveDataDir('', paths.packageDir)).toBe(join(paths.repoRoot, '.pglite'));
    expect(resolveDataDir('data/dev', paths.packageDir)).toBe(join(paths.repoRoot, 'data', 'dev'));
  });

  it('recognizes in-memory values and absolute paths', () => {
    for (const value of ['memory', ':memory:', 'memory://', ' MEMORY ']) expect(resolveDataDir(value)).toBe('memory');
    expect(resolveDataDir('/var/lib/paceline')).toBe('/var/lib/paceline');
  });

  it('falls back to cwd outside a workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'paceline-paths-'));
    try {
      await mkdir(join(dir, 'a'));
      expect(resolveDataDir('.pglite', join(dir, 'a'))).toBe(join(dir, 'a', '.pglite'));
      await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
      expect(resolveDataDir('.pglite', join(dir, 'a'))).toBe(join(dir, '.pglite'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
