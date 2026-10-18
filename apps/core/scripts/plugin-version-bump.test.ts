/**
 * The plugin-version workflow's bump step publishes a new plugin version to
 * every autoUpdate install. verify-dist checks only $GITHUB_SHA, so the bump
 * must not rebase onto, and push, a plugins/claude-code tree nobody verified
 * (for example a hand-edited dist that landed on main while the run was queued).
 *
 * This runs the step's real shell (extracted from the workflow file) against a
 * local bare repo. No network: the "origin" is a directory.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'plugin-version.yml');
const has = (cmd: string) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'y-plugin-bump-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The `run: |` body of the bump step, de-indented. */
function bumpScript(): string {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes('- name: Bump the patch version'));
  const run = lines.findIndex((l, i) => i > start && /^\s*run: \|\s*$/.test(l));
  expect(start).toBeGreaterThan(-1);
  expect(run).toBeGreaterThan(start);
  const body: string[] = [];
  let indent = -1;
  for (const l of lines.slice(run + 1)) {
    if (l.trim() === '') {
      body.push('');
      continue;
    }
    const n = l.length - l.trimStart().length;
    if (indent < 0) indent = n;
    if (n < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

// Hermetic git: no user config (signing, hooks, templates) leaks in.
const gitEnv = (() => {
  const cfg = path.join(tmp, 'gitconfig');
  fs.writeFileSync(cfg, '[user]\n\tname = t\n\temail = t@example.test\n[init]\n\tdefaultBranch = main\n');
  return { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' };
})();
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const PLUGIN_JSON = 'plugins/claude-code/.claude-plugin/plugin.json';
const DIST = 'plugins/claude-code/scripts/dist/hook.mjs';

/** Push A (verified), then optionally a racing push B, then run A's bump step. */
function runCase(name: string, racing: 'none' | 'other' | 'plugin') {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  const origin = path.join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', origin);
  const w = path.join(dir, 'w');
  git(dir, 'clone', '-q', origin, w);
  write(w, PLUGIN_JSON, '{"version":"0.1.7"}\n');
  write(w, DIST, 'export const v = 1;\n');
  write(w, 'README', 'x\n');
  git(w, 'add', '-A');
  git(w, 'commit', '-qm', 'base');
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  const before = git(w, 'rev-parse', 'HEAD');
  write(w, DIST, 'export const v = 2;\n');
  git(w, 'commit', '-qam', 'A');
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  const sha = git(w, 'rev-parse', 'HEAD');

  const other = path.join(dir, 'other');
  git(dir, 'clone', '-q', origin, other);
  if (racing !== 'none') {
    if (racing === 'other') write(other, 'README', 'y\n');
    else write(other, DIST, 'export const v = "hand-edited";\n');
    git(other, 'commit', '-qam', 'B');
    git(other, 'push', '-q', 'origin', 'HEAD:main');
  }

  const r = spawnSync('bash', ['-c', bumpScript()], {
    cwd: w,
    env: { ...gitEnv, GITHUB_SHA: sha, BEFORE: before },
    encoding: 'utf8',
  });
  git(other, 'pull', '-q', 'origin', 'main');
  return {
    status: r.status,
    output: `${r.stdout}\n${r.stderr}`,
    version: (JSON.parse(fs.readFileSync(path.join(other, PLUGIN_JSON), 'utf8')) as { version: string }).version,
    log: git(other, 'log', '--format=%s').split('\n'),
  };
}

describe.skipIf(!has('git') || !has('jq'))('plugin-version bump step', () => {
  it('bumps the verified commit when main has not moved', () => {
    const r = runCase('none', 'none');
    expect(r.status, r.output).toBe(0);
    expect(r.version).toBe('0.1.8');
    expect(r.log[0]).toMatch(/^Plugin 0\.1\.8 \(auto-bump/);
  });

  it('still rebases over unrelated pushes and bumps', () => {
    const r = runCase('other', 'other');
    expect(r.status, r.output).toBe(0);
    expect(r.version).toBe('0.1.8');
    expect(r.log.slice(0, 2)).toEqual([expect.stringMatching(/^Plugin 0\.1\.8/), 'B']);
  });

  it('does not publish a plugin tree that landed after verification', () => {
    const r = runCase('plugin', 'plugin');
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('leaving the bump to that push');
    expect(r.version).toBe('0.1.7');
    expect(r.log[0]).toBe('B');
  });
});
