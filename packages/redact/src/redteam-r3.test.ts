/**
 * Red-team round 3 regressions for @y/redact (R22: the `declare|typeset`
 * env-dump branch was quadratic on a long flag run). Synthetic fixtures only.
 */
import { describe, expect, it } from 'vitest';
import { ENV_DUMP_COMMAND_RE, redact } from './index.js';

const ms = (f: () => unknown) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};

describe('R22 declare/typeset flag runs', () => {
  it('runs in linear time on a long flag run that does not end the command', () => {
    // Before: 'declare -' + 'x' x 20k + ' y' took ~1.4–14 s.
    for (const head of ['declare -', 'typeset -']) {
      for (const c of ['x', 'p', 'a']) {
        const s = head + c.repeat(20_000) + ' y';
        expect(ms(() => ENV_DUMP_COMMAND_RE.test(s)), `${head}${c}`).toBeLessThan(200);
      }
    }
    expect(ms(() => redact('TOOL Bash: declare -' + 'x'.repeat(20_000) + ' y'))).toBeLessThan(400);
  });

  it('matches the same declare/typeset commands as before', () => {
    const OLD = /^(?:declare|typeset)\s+-[A-Za-z]*[xp][A-Za-z]*(?=\s*(?:$|[|;&>)\n⏎]))/;
    const NEW = /^(?:declare|typeset)\s+-(?=[A-Za-z]*[xp])[A-Za-z]+(?=\s*(?:$|[|;&>)\n⏎]))/;
    const pieces = ['declare', 'typeset', ' ', '-', 'x', 'p', 'a', 'X', 'r', '|', ';', '\n', 'y', '=', '1'];
    let seed = 7;
    const R = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 20_000; i++) {
      let s = Math.floor(R() * 2) ? 'declare -' : 'typeset -';
      const n = Math.floor(R() * 8);
      for (let j = 0; j < n; j++) s += pieces[Math.floor(R() * pieces.length)];
      expect(NEW.test(s), JSON.stringify(s)).toBe(OLD.test(s));
    }
    for (const cmd of ['declare -x', 'declare -p', 'typeset -px', 'declare -ax | grep KEY']) expect(ENV_DUMP_COMMAND_RE.test(cmd), cmd).toBe(true);
    for (const cmd of ['declare -a arr', 'declare -x FOO=1', 'typeset -i n']) expect(ENV_DUMP_COMMAND_RE.test(cmd), cmd).toBe(false);
  });
});
