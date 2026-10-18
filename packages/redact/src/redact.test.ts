import { describe, expect, it } from 'vitest';
import {
  FAIL_CLOSED_THRESHOLD,
  hasResidualMarkers,
  identityTermsFrom,
  looksLikeSecret,
  redact,
  redactCommandOutput,
  scanSecrets,
  shannonEntropy,
} from './index.js';

/* Synthetic fake secrets, generated at test time from a seeded PRNG so no
 * secret-shaped literal is committed. They look real but are invalid. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const R = rng(42);
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_NUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B64 = ALNUM + '+/';
const B64URL = ALNUM + '-_';
const HEX = '0123456789abcdef';
const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[Math.floor(R() * alphabet.length)]).join('');
// Ensure mixed classes for strings that must contain digits.
const mixed = (alphabet: string, n: number) => pick(alphabet, n - 2) + 'q7';

const P = (...xs: string[]) => xs.join('');
const canaries: { rule: string; secret: string; context: (s: string) => string }[] = [
  { rule: 'aws_access_key', secret: P('AK', 'IA', pick(UPPER_NUM, 16)), context: (s) => `aws key ${s} in config` },
  { rule: 'aws_access_key', secret: P('AS', 'IA', pick(UPPER_NUM, 16)), context: (s) => `session key=${s}` },
  { rule: 'aws_secret_key', secret: mixed(B64, 40), context: (s) => `aws_secret_access_key = ${s}` },
  { rule: 'github_pat', secret: P('github', '_pat_', mixed(ALNUM + '_', 82)), context: (s) => `token ${s}` },
  { rule: 'github_token', secret: P('gh', 'p_', mixed(ALNUM, 36)), context: (s) => `GH ${s} ok` },
  { rule: 'github_token', secret: P('gh', 's_', mixed(ALNUM, 36)), context: (s) => `${s}` },
  { rule: 'github_token', secret: P('gh', 'o_', mixed(ALNUM, 36)), context: (s) => `x ${s}` },
  { rule: 'anthropic_key', secret: P('sk-', 'ant-', 'api03-', mixed(B64URL, 90)), context: (s) => `ANTHROPIC ${s}` },
  { rule: 'openai_key', secret: P('sk-', 'proj-', mixed(B64URL, 48)), context: (s) => `key ${s}` },
  { rule: 'openai_key', secret: P('sk-', mixed(ALNUM, 48)), context: (s) => `key ${s}` },
  { rule: 'openai_key', secret: P('sk-', 'svcacct-', mixed(B64URL, 40)), context: (s) => `key ${s}` },
  { rule: 'stripe_key', secret: P('sk', '_live_', mixed(ALNUM, 24)), context: (s) => `stripe ${s}` },
  { rule: 'stripe_key', secret: P('rk', '_test_', mixed(ALNUM, 24)), context: (s) => `stripe ${s}` },
  { rule: 'stripe_webhook', secret: P('wh', 'sec_', mixed(ALNUM, 32)), context: (s) => `hook ${s}` },
  { rule: 'slack_token', secret: P('xo', 'xb-', pick('0123456789', 12), '-', mixed(ALNUM, 24)), context: (s) => `slack ${s}` },
  { rule: 'slack_token', secret: P('xo', 'xp-', pick('0123456789', 12), '-', mixed(ALNUM, 24)), context: (s) => `slack ${s}` },
  {
    rule: 'slack_webhook',
    secret: P('https://hooks.', 'slack.com/services/T', pick(UPPER_NUM, 8), '/B', pick(UPPER_NUM, 8), '/', mixed(ALNUM, 24)),
    context: (s) => `post to ${s} now`,
  },
  { rule: 'google_api_key', secret: P('AI', 'za', mixed(B64URL, 35)), context: (s) => `maps ${s}` },
  { rule: 'jwt', secret: P('ey', 'JhbGciOiJIUzI1NiJ9.', 'ey', mixed(B64URL, 40), '.', mixed(B64URL, 43)), context: (s) => `cookie ${s}` },
  { rule: 'paceline_token', secret: P('pcl', '_agt_', mixed(B64URL, 32)), context: (s) => `install ${s}` },
  { rule: 'npm_token', secret: P('np', 'm_', mixed(ALNUM, 36)), context: (s) => `//registry:_authToken=${s}` },
  { rule: 'bearer_token', secret: mixed(B64URL, 40), context: (s) => `Authorization: Bearer ${s}` },
  { rule: 'url_credentials', secret: `deploy:${mixed(ALNUM, 16)}`, context: (s) => `postgres://${s}@db.example.com:5432/app` },
  { rule: 'generic_assignment', secret: mixed(ALNUM, 18), context: (s) => `DB_PASSWORD="${s}"` },
  { rule: 'generic_assignment', secret: mixed(ALNUM, 14), context: (s) => `api_key: ${s}` },
  { rule: 'entropy', secret: mixed(B64, 44), context: (s) => `blob ${s} end` },
  { rule: 'entropy', secret: P(pick(HEX, 30), 'a1'), context: (s) => `hexkey ${s}` },
  {
    rule: 'pem_private_key',
    secret: P('-----BEGIN ', 'RSA PRIVATE KEY-----\n', mixed(B64, 64), '\n', mixed(B64, 64), '\n-----END ', 'RSA PRIVATE KEY-----'),
    context: (s) => `key:\n${s}\ndone`,
  },
];

describe('canary: every rule type is redacted', () => {
  for (const c of canaries) {
    it(`${c.rule}: ${c.context('<s>')}`, () => {
      const input = c.context(c.secret);
      const r = redact(input);
      expect(r.dropped).toBe(false);
      expect(r.text).not.toContain(c.secret);
      expect(r.text).toContain(`<REDACTED:${c.rule}>`);
      expect(r.hitsByRule[c.rule]).toBe(1);
      // scanSecrets agrees and reports positions only.
      const hits = scanSecrets(input);
      expect(hits.map((h) => h.ruleId)).toContain(c.rule);
      expect(JSON.stringify(hits)).not.toContain(c.secret);
      // Idempotent and the second pass reports nothing.
      const again = redact(r.text);
      expect(again.text).toBe(r.text);
      expect(again.hitsByRule).toEqual({});
    });
  }

  it('a digest with all canaries leaks none of them (fail-closed off)', () => {
    const digest = canaries.map((c) => `TOOL Bash: echo ${c.context(c.secret).replace(/\n/g, ' ⏎ ')}`).join('\n');
    const r = redact(digest, { failClosedThreshold: 1000 });
    for (const c of canaries) {
      // PEM bodies are collapsed in digests; check each line of the secret.
      for (const part of c.secret.split('\n').filter((p) => p.length > 20 && !p.startsWith('-----'))) expect(r.text).not.toContain(part);
    }
  });
});

describe('fail closed', () => {
  it(`drops text with more than ${FAIL_CLOSED_THRESHOLD} secret hits`, () => {
    const text = canaries.slice(0, 6).map((c) => c.context(c.secret)).join('\n');
    const r = redact(text);
    expect(r.dropped).toBe(true);
    expect(r.text).toBe('');
    expect(Object.values(r.hitsByRule).reduce((a, b) => a + b, 0)).toBeGreaterThan(FAIL_CLOSED_THRESHOLD);
  });
  it('identity hits do not count toward fail closed', () => {
    const r = redact('a@b.io c@d.io e@f.io g@h.io i@j.io k@l.io m@n.io');
    expect(r.dropped).toBe(false);
    expect(r.hitsByRule.identity_email).toBe(7);
  });
});

describe('env dumps', () => {
  it('redacts env-dump command output wholesale', () => {
    const r = redactCommandOutput('printenv', 'PATH=/usr/bin\nHOME=/Users/x\nFOO=bar');
    expect(r).toEqual({ text: '<REDACTED:env_dump>', hitsByRule: { env_dump: 1 }, dropped: false });
    expect(redactCommandOutput('cat .env.local', 'X=1').text).toBe('<REDACTED:env_dump>');
    expect(redactCommandOutput('pnpm test', 'Tests 3 passed').text).toBe('Tests 3 passed');
  });
  it('redacts the result line after a TOOL Bash env line in a digest', () => {
    const d = 'USER: debug env\nTOOL Bash: env | sort\nOK Bash: SHELL=zsh ⏎ TERM=xterm\nASSISTANT: done';
    const r = redact(d);
    expect(r.text).toBe('USER: debug env\nTOOL Bash: env | sort\nOK Bash: <REDACTED:env_dump>\nASSISTANT: done');
  });
  it('redacts runs of 3+ KEY=value lines', () => {
    const r = redact('output:\nNODE_ENV=production\nDATABASE_URL=x\nREDIS_HOST=y\nend');
    expect(r.text).toBe('output:\n<REDACTED:env_dump>\nend');
  });
});

describe('identity', () => {
  const terms = identityTermsFrom({
    gitUser: 'Ada Lovelace',
    gitEmail: 'ada.l@analytical.example',
    hostname: 'adas-mbp.local',
    remote: 'git@github.com:Analytica/engine-room.git',
    packageName: '@analytica/difference-engine',
    dirname: 'engine-room',
    denylist: ['Project Babbage', 'ok'],
  });
  it('derives terms', () => {
    expect(terms.user).toEqual(['Ada Lovelace', 'Ada', 'Lovelace', 'ada.l']);
    expect(terms.host).toEqual(['adas-mbp.local', 'adas-mbp']);
    expect(terms.org).toEqual(['Analytica']);
    expect(terms.project).toEqual(['engine-room', 'difference-engine']);
    expect(terms.denylist).toEqual(['Project Babbage']);
    expect(terms.email).toEqual(['ada.l@analytical.example']);
  });
  it('replaces identity terms, emails, IPs and home paths', () => {
    const r = redact(
      'Ada Lovelace (ada.l@analytical.example) on adas-mbp pushed analytica/engine-room; see /Users/ada/code/engine-room/src/a.ts; Project Babbage; db 10.0.0.5:5432; mail bob@corp.example',
      { identityTerms: terms },
    );
    expect(r.text).toBe(
      '<USER> (<EMAIL>) on <HOST> pushed <ORG>/<PROJECT>; see ~/code/<PROJECT>/src/a.ts; <TERM>; db <IP>:5432; mail <EMAIL>',
    );
    expect(redact(r.text, { identityTerms: terms }).text).toBe(r.text);
  });
});

describe('benign code is not over-redacted', () => {
  const benign = [
    'const token = await getToken(session);',
    'export function computeStatsWithSubagentDedupe(records) { return records; }',
    'password: string; apiKey?: ApiKeyType;',
    'const secret = process.env.STRIPE_SECRET_KEY;',
    'headers: { Authorization: `Bearer ${token}` }',
    'git checkout 3f9a1c2e7b4d5f6a8c9e0b1d2f3a4b5c6d7e8f90',
    'sha256 9f86d081884c7d659a2feaf0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'id 01J9ZQ8V7K3M4N5P6Q7R8S9T0V and a_01J9ZQ8V7K3M4N5P6Q7R8S9T0V, uuid 123e4567-e89b-12d3-a456-426614174000',
    'import { describe, expect, it } from "vitest"; // packages/redact/src/redact.test.ts',
    'https://github.com/vitest-dev/vitest/blob/main/packages/vitest/src/node/cli.ts',
    'node v22.22.2 pnpm 10.18.3 next@16.0.0-canary.20251001',
    'Error: connect ETIMEDOUT after 30000ms',
    'sk-learn is a library; task-runner-config-file-name works',
    'The quick brown fox jumps over the lazy dog while refactoring parseClaudeRecordsDefensively.',
  ];
  for (const b of benign) {
    it(b, () => {
      const r = redact(b);
      expect(r.text).toBe(b);
      expect(r.hitsByRule).toEqual({});
    });
  }
});

describe('helpers', () => {
  it('shannonEntropy', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
  });
  it('looksLikeSecret', () => {
    expect(looksLikeSecret(mixed(B64, 40))).toBe(true);
    expect(looksLikeSecret('a'.repeat(40))).toBe(false);
    expect(looksLikeSecret('9f86d081884c7d659a2feaf0c55ad015a3bf4f1b')).toBe(false);
    expect(looksLikeSecret('src/components/ButtonGroup/index.tsx')).toBe(false);
  });
  it('hasResidualMarkers', () => {
    expect(hasResidualMarkers('x <REDACTED:jwt> y')).toBe(true);
    expect(hasResidualMarkers('hi <USER>')).toBe(true);
    expect(hasResidualMarkers('hi <IP>')).toBe(true);
    expect(hasResidualMarkers('a < b > c')).toBe(false);
  });
  it('existing markers are not counted', () => {
    expect(redact('<REDACTED:github_pat> and <USER>').hitsByRule).toEqual({});
  });
});
