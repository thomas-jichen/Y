/**
 * deploy.sh must not put Y_INTERNAL_SECRET (the core<->mcp HMAC key) in any process's
 * argv, and must use the pinned workspace mcp-use CLI rather than `npx mcp-use`.
 * A fake CLI entry records what it was handed in-process and what the OS shows
 * for its own process and its parent (via `ps`), so the test sees the real
 * command lines.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { envSetArgs, mcpUseBin } from './mcp-use-env-set.js';

const MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(MCP, 'node_modules', '.bin', 'tsx');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'y-mcp-envset-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Synthetic, invalid value; only its absence from argv matters.
const SECRET = 'synthetic-internal-secret-Qx7vR2mL9pT4wZ8k';

const FAKE_BIN = `
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const ps = (pid) => { try { return execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }); } catch { return ''; } };
writeFileSync(process.env.FAKE_OUT, JSON.stringify({ args: process.argv.slice(2), self: ps(process.pid), parent: ps(process.ppid) }));
`;

describe('mcp-use-env-set', () => {
  it('builds the CLI argv the old shell call used', () => {
    expect(envSetArgs('srv_1', 'Y_INTERNAL_SECRET', 'v', true)).toEqual(['servers', 'env', 'set', 'srv_1', 'Y_INTERNAL_SECRET=v', '--secret', '--json']);
    expect(envSetArgs('srv_1', 'Y_CORE_URL', 'https://core.example.test', false)).toEqual([
      'servers',
      'env',
      'set',
      'srv_1',
      'Y_CORE_URL=https://core.example.test',
      '--json',
    ]);
  });

  it('resolves the pinned workspace mcp-use CLI by default', () => {
    const bin = mcpUseBin({});
    expect(fs.existsSync(bin)).toBe(true);
    expect(bin).toMatch(/mcp-use[^/]*\/node_modules\/mcp-use\/dist\/bin\.js$/);
  });

  it('hands the CLI KEY=VALUE in-process while no OS-visible argv carries the value', () => {
    const bin = path.join(tmp, 'fake-bin.mjs');
    const out = path.join(tmp, 'out.json');
    fs.writeFileSync(bin, FAKE_BIN);
    const r = spawnSync(TSX, [path.join(MCP, 'scripts', 'mcp-use-env-set.ts'), 'srv_1', 'Y_INTERNAL_SECRET', '--secret'], {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, Y_INTERNAL_SECRET: SECRET, Y_MCP_USE_BIN: bin, FAKE_OUT: out },
      timeout: 60_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const got = JSON.parse(fs.readFileSync(out, 'utf8')) as { args: string[]; self: string; parent: string };
    expect(got.args).toEqual(['servers', 'env', 'set', 'srv_1', `Y_INTERNAL_SECRET=${SECRET}`, '--secret', '--json']);
    expect(got.self).toContain('mcp-use-env-set.ts');
    expect(got.self).not.toContain(SECRET);
    expect(got.parent).not.toContain(SECRET);
  }, 90_000);

  it('refuses to run when the value is not in the environment', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, Y_MCP_USE_BIN: path.join(tmp, 'never-run.mjs') };
    delete env.Y_INTERNAL_SECRET;
    const r = spawnSync(TSX, [path.join(MCP, 'scripts', 'mcp-use-env-set.ts'), 'srv_1', 'Y_INTERNAL_SECRET', '--secret'], {
      cwd: tmp,
      encoding: 'utf8',
      env,
      timeout: 60_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Y_INTERNAL_SECRET is not set');
  }, 90_000);
});

describe('deploy.sh', () => {
  const script = fs.readFileSync(path.join(MCP, 'scripts', 'deploy.sh'), 'utf8');
  const code = script
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');

  it('never expands Y_INTERNAL_SECRET into a command argument', () => {
    const uses = code.split('\n').filter((l) => /\$\{?Y_INTERNAL_SECRET/.test(l));
    // Only the `: "${Y_INTERNAL_SECRET:?...}"` presence guard may reference the value.
    expect(uses).toEqual([': "${Y_INTERNAL_SECRET:?set Y_INTERNAL_SECRET (same value as core)}"']);
    expect(code).toContain('env_set "$1" Y_INTERNAL_SECRET --secret');
  });

  it('runs mcp-use from the pinned workspace install, not npx', () => {
    expect(code).not.toMatch(/\bnpx\s+mcp-use\b/);
    expect(code).toContain('node_modules/mcp-use/dist/bin.js');
  });

  it('is valid bash', () => {
    expect(() => execFileSync('bash', ['-n', path.join(MCP, 'scripts', 'deploy.sh')])).not.toThrow();
  });
});
