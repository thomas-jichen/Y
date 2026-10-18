/**
 * Red-team round 3 (R21): command-line password masking keeps ordinary
 * arguments (counts, flags of other commands, port mappings). Synthetic only.
 */
import { describe, expect, it } from 'vitest';
import { maskCliSecrets } from './digest.js';

describe('R21 CLI masking leaves ordinary arguments alone', () => {
  it('count-like and lower-case pass names are not secrets', () => {
    for (const c of [
      'MAX_TOKENS=4096 python eval.py',
      'NUM_TOKENS=12 ./bench',
      'TOKEN_TTL=3600 node server.js',
      'PASSWORD_MIN_LENGTH=12 pnpm test',
      'python train.py max_tokens=512 pass_through=true',
      'OLDPWD=/x make',
    ]) {
      expect(maskCliSecrets(c), c).toBe(c);
    }
  });

  it('per-tool flags apply only to that tool’s own command', () => {
    for (const c of [
      'mkdir -pv out && mysql -u root app',
      'docker login -u bob --password-stdin registry.example.test && docker run -p 8080:80 app',
      'docker run -u 1000:1000 img; curl https://api.example.test',
      'redis-cli ping; tar -a -cf x.tgz src',
    ]) {
      expect(maskCliSecrets(c), c).toBe(c);
    }
  });

  it('still masks real passwords, including next to other commands', () => {
    const cases: [string, string][] = [
      ['GITHUB_TOKEN=ghx_fake ./release', 'GITHUB_TOKEN=<REDACTED:cli_password> ./release'],
      ['export DB_PASSWORD=Hunter2x && ./run', 'export DB_PASSWORD=<REDACTED:cli_password> && ./run'],
      ['api_token=abc123 ./x', 'api_token=<REDACTED:cli_password> ./x'],
      ['DB_PASS=s3cretA ./run', 'DB_PASS=<REDACTED:cli_password> ./run'],
      ['cd app && mysql -u root -pHunter2 -e "select 1; select 2"', 'cd app && mysql -u root -p<REDACTED:cli_password> -e "select 1; select 2"'],
      ['mysql -e "select 1; select 2" -pHunter2 app', 'mysql -e "select 1; select 2" -p<REDACTED:cli_password> app'],
      ['mysql \\\n  -pHunter2 app', 'mysql \\\n  -p<REDACTED:cli_password> app'],
      ['make build && docker login -u bob -p DockerPw1 r.example.test', 'make build && docker login -u bob -p <REDACTED:cli_password> r.example.test'],
      ['ls; curl -u bob:pa55word https://api.example.test', 'ls; curl -u bob:<REDACTED:cli_password> https://api.example.test'],
      ['redis-cli -h cache -a RedisPw123 ping | head', 'redis-cli -h cache -a <REDACTED:cli_password> ping | head'],
    ];
    for (const [cmd, want] of cases) expect(maskCliSecrets(cmd), cmd).toBe(want);
  });
});
