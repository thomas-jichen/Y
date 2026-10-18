/**
 * Every `tsx <file>` script in eval/package.json must point at a file that exists,
 * and the placeholders must fail clearly (exit 2, a "not implemented" message)
 * rather than with ERR_MODULE_NOT_FOUND.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOT_IMPLEMENTED_EXIT } from './not-implemented.js';

const EVAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(EVAL, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const tsxScripts = Object.entries(pkg.scripts).flatMap(([name, cmd]) => {
  const m = /^tsx\s+(\S+\.ts)\b/.exec(cmd);
  return m ? [[name, m[1]!] as const] : [];
});

describe('eval package scripts', () => {
  it('has the eval and eval:validate scripts', () => {
    expect(tsxScripts.map(([n]) => n).sort()).toEqual(['eval', 'eval:validate']);
  });

  it.each(tsxScripts)('%s points at an existing file (%s)', (_name, file) => {
    expect(fs.existsSync(path.join(EVAL, file))).toBe(true);
  });

  it.each(tsxScripts)('%s exits %i with a not-implemented message', (name, file) => {
    const r = spawnSync(path.join(EVAL, 'node_modules', '.bin', 'tsx'), [file], { cwd: EVAL, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(NOT_IMPLEMENTED_EXIT);
    expect(r.stderr).toContain(`@y/eval ${name}: the eval harness is not implemented yet`);
    expect(r.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  }, 90_000);
});
