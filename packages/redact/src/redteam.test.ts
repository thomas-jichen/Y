/**
 * Red-team regressions for @y/redact (#6 generic_assignment ReDoS, #99 URL
 * passwords with `/` and env-dump command variants). Synthetic fixtures only.
 */
import { describe, expect, it } from 'vitest';
import { ENV_DUMP_COMMAND_RE, redact, redactCommandOutput, scanSecrets } from './index.js';
import { genericAssignmentMatches } from './redact.js';

/** The pre-fix generic_assignment regex: the linear matcher must find exactly its matches. */
const OLD_GENERIC =
  /\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|client[_-]?secret|credentials?)[A-Za-z0-9_.-]*["']?\s*(?::=|=>|=|:)\s*(["']?)([^\s"'`,;()[\]{}<>]{8,})\1/dgi;

function oldMatches(text: string): { start: number; end: number; value: string }[] {
  const out: { start: number; end: number; value: string }[] = [];
  for (const m of text.matchAll(OLD_GENERIC)) {
    const idx = (m as RegExpMatchArray & { indices?: [number, number][] }).indices?.[2];
    if (idx && m[2] !== undefined) out.push({ start: idx[0], end: idx[1], value: m[2] });
  }
  return out;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ms = (f: () => unknown) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};

describe('generic_assignment (#6)', () => {
  it('finds exactly the matches of the original regex (randomized)', () => {
    const R = rng(7);
    const pieces = ['token', 'TOKEN', 'pass', 'word', 'password', 'api', '_key', '-key', 'secret', 'client', 'cred', 'entials', 'pwd',
      '=', ':', '=>', ':=', '"', "'", '`', ' ', '  ', '\t', '\n', '.', '-', '_', 'a', 'Q7', 'x9', 'Zz', '12345678', 'abc', '>', '{', ',', ';', '(', '$', 'é'];
    for (let i = 0; i < 6000; i++) {
      const n = 1 + Math.floor(R() * 16);
      let s = '';
      for (let j = 0; j < n; j++) s += pieces[Math.floor(R() * pieces.length)];
      expect(genericAssignmentMatches(s), JSON.stringify(s)).toEqual(oldMatches(s));
    }
  });

  it('still redacts the usual key forms', () => {
    for (const [input, value] of [
      ['DB_PASSWORD=Hx7kQ2mN9pL4vR8s', 'Hx7kQ2mN9pL4vR8s'],
      ['api_key: "Zq8xV2mN4pL7rT1y"', 'Zq8xV2mN4pL7rT1y'],
      ['client-secret => Wb3nK8qL2mZ7xV5c', 'Wb3nK8qL2mZ7xV5c'],
      ['config.auth.token=Pd4rT9wQ1zX6cV3b', 'Pd4rT9wQ1zX6cV3b'],
      ["export GITHUB_TOKEN='Mk2jH7gF4dS9aL1q'", 'Mk2jH7gF4dS9aL1q'],
    ] as const) {
      const r = redact(input);
      expect(r.text, input).not.toContain(value);
      expect(r.hitsByRule.generic_assignment, input).toBe(1);
    }
    expect(redact('password: passwordField').hitsByRule).toEqual({});
    expect(redact('token = tokenFromHeader').hitsByRule).toEqual({});
  });

  it('is linear on keyword runs with no operator', () => {
    // Before the fix: ~1.8 s for 4,000 chars of 'token-' and ~33 s for 10 KB of 'token.'.
    expect(ms(() => scanSecrets('token-'.repeat(667)))).toBeLessThan(1000);
    expect(ms(() => redact('token.'.repeat(1667)))).toBeLessThan(1000);
    expect(ms(() => redact('password_'.repeat(22_000)))).toBeLessThan(5000);
  });
});

describe('url_credentials (#99)', () => {
  it('redacts a password containing "/"', () => {
    const r = redact('postgres://admin:s3cr/etP4ss@db.internal.example:5432/app');
    expect(r.text).not.toContain('s3cr');
    expect(r.text).not.toContain('etP4ss');
    expect(r.hitsByRule.url_credentials).toBe(1);
  });

  it('leaves host:port/path@… URLs alone', () => {
    for (const url of ['https://registry.npmjs.org:443/@scope/pkg', 'http://localhost:3000/users/someone@example.com', 'docker://registry:5000/img@sha256']) {
      expect(scanSecrets(url).map((h) => h.ruleId), url).not.toContain('url_credentials');
    }
  });
});

describe('env dump commands (#99)', () => {
  it('matches more ways of dumping the environment', () => {
    for (const cmd of [
      'env -0',
      '/usr/bin/env',
      'sudo env',
      'sudo -E printenv',
      'export',
      'declare -x',
      'typeset -p',
      'cd app\nenv',
      'cd app ⏎ env | sort',
      'cat<.env',
      'grep . .env',
      'sort .env.local',
      'grep API config/.env.production',
      `node -e 'console.log(process.env)'`,
      `python -c 'import os; print(os.environ)'`,
    ]) {
      expect(ENV_DUMP_COMMAND_RE.test(cmd), cmd).toBe(true);
      expect(redactCommandOutput(cmd, 'A=1\nB=2').text, cmd).toBe('<REDACTED:env_dump>');
    }
  });

  it('still leaves ordinary commands alone', () => {
    for (const cmd of [
      'env NODE_ENV=test pnpm test',
      'set -e',
      'set -euo pipefail; pnpm test',
      'export FOO=1',
      'declare -x FOO=1',
      'grep -rn process.env src',
      'cat src/env.ts',
      `node -e 'console.log(process.env.HOME)'`,
      '#!/usr/bin/env node',
      'echo environment',
    ]) {
      expect(ENV_DUMP_COMMAND_RE.test(cmd), cmd).toBe(false);
    }
  });

  it('redacts the output of a digest line that runs env -0', () => {
    const digest = 'TOOL Bash: env -0\nOK Bash: HOME=/x DB_PASS=hunter-two-words';
    expect(redact(digest).text).not.toContain('hunter');
  });
});
