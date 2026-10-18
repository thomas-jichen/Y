/**
 * Red-team #5 (round 2): values of keys whose name is a secret are redacted
 * whatever their entropy or digits, in JSON, YAML, INI/.env and shell forms.
 * Synthetic, deliberately low-entropy values only.
 */
import { describe, expect, it } from 'vitest';
import { redact, scanSecrets } from './index.js';
import { secretKeyKind } from './redact.js';

const ms = (f: () => unknown) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};

describe('#5 secret-named keys', () => {
  it('redacts low-entropy values of password / secret / token keys', () => {
    for (const [input, value] of [
      ['"password": "Summer-sky"', 'Summer-sky'],
      ['{"db": {"password": "Summer-sky", "port": 5432}}', 'Summer-sky'],
      ['password: hunter two', 'hunter two'],
      ['  + password: hunter two  # prod', 'hunter two'],
      ['- password: hunter two', 'hunter two'],
      ['config:\n  password: hunter two\n  port: 5432', 'hunter two'],
      ['CONFIG app.yml: ⏎ + db: ⏎ +   password: hunter two ⏎ + port: 5432', 'hunter two'],
      ['OK Bash: password: hunter two', 'hunter two'],
      ['DB_PASSWORD=CorrectHorseBatteryStaple', 'CorrectHorseBatteryStaple'],
      ['export DB_PASSWORD=CorrectHorseBatteryStaple', 'CorrectHorseBatteryStaple'],
      ['TOOL Bash: PGPASSWORD=Summersky psql -h db -U app', 'Summersky'],
      ['MYSQL_PWD=Summersky mysql -u root', 'Summersky'],
      ['spring.datasource.password=hunter2', 'hunter2'],
      ['password = hunter2', 'hunter2'],
      ["admin_pass: 'Summer sky'", 'Summer sky'],
      ['{\\"password\\": \\"Summer-sky\\"}', 'Summer-sky'],
      ['token: abc123def', 'abc123def'],
      ['"api_key": "ab12cd34ef"', 'ab12cd34ef'],
      ['client_secret = "Pass1234"', 'Pass1234'],
      ['"auth": "dXNlcjpw9w=="', 'dXNlcjpw9w=='],
      ['JWT_SECRET=abc123def', 'abc123def'],
    ] as const) {
      const r = redact(input);
      expect(r.text, input).not.toContain(value);
      expect(r.hitsByRule, input).toEqual({ generic_assignment: 1 });
      expect(r.dropped).toBe(false);
      expect(scanSecrets(input).map((h) => h.ruleId), input).toEqual(['generic_assignment']);
      // Idempotent.
      expect(redact(r.text).text, input).toBe(r.text);
    }
  });

  it('keeps the rest of the line and neighbouring keys', () => {
    expect(redact('"user": "app", "password": "Summer-sky", "port": 5432').text).toBe(
      '"user": "app", "password": "<REDACTED:generic_assignment>", "port": 5432',
    );
    expect(redact('PGPASSWORD=Summersky psql -h db').text).toBe('PGPASSWORD=<REDACTED:generic_assignment> psql -h db');
    expect(redact('a ⏎ password: hunter two ⏎ b').text).toBe('a ⏎ password: <REDACTED:generic_assignment> ⏎ b');
  });

  it('never treats counters, limits or other non-secret keys as secrets', () => {
    for (const key of ['token_count', 'password_min_length', 'max_tokens', 'authorEmail', 'passwordField', 'Authorization', 'tokenizer',
      'secret_name', 'password_hash', 'bypass', 'compass', 'oauth', 'keyboard', 'apiKeyType', 'PASSWORD_RESET_URL']) {
      expect(secretKeyKind(key), key).toBeUndefined();
    }
    for (const key of ['password', 'DB_PASSWORD', 'PGPASSWORD', 'adminPasswd', 'pwd', 'DB_PASS', 'secret', 'clientSecret', 'api_key', 'apiKey',
      'apikey', 'access-key', 'private_key', '_authToken', 'auth', 'credentials', 'spring.datasource.password']) {
      expect(secretKeyKind(key), key).toBeDefined();
    }
    for (const input of [
      'token_count: 12345678',
      'password_min_length: 12345678',
      'max_tokens: 4096000',
      'authorEmail: "ada99@x"',
      'passwordField: "Summer-sky"',
    ]) {
      expect(redact(input).hitsByRule, input).toEqual({});
    }
  });

  it('leaves code, types, references, placeholders and slugs alone', () => {
    for (const input of [
      'password: string;',
      'password: string | null',
      'password: Optional[str]',
      'password: str = Field(min_length=8)',
      'password: hashedPassword,',
      'password: newPw',
      'password: hashed_pw',
      'this.token = token;',
      'user.password = req.body.password',
      'password = get_password()',
      'if (password === "Summer-sky") return;',
      'if (password == "Summer-sky") return;',
      'const token = "abc"',
      'token => token.trim()',
      'password: ${{ secrets.DB_PASSWORD }}',
      'password: "${DB_PASSWORD}"',
      'password: "{{ vault_db }}"',
      'TOKEN=$GITHUB_TOKEN',
      'DB_PASSWORD=$(cat /run/db)',
      'password: <your password>',
      'password: "changeme"',
      'password: "********"',
      'password: true',
      'auth: false',
      'auth: "oauth2"',
      'auth: { type: basic }',
      'secret: my-app-creds',
      'token: "a phrase 123"',
      'api_token="correct-horse-battery-staple"',
      'version: 1.2.3',
      'credentials: ~/.aws/credentials',
      'password: |',
      'return { password, token };',
      'The password: it must be at least 8 characters long.',
    ]) {
      expect(redact(input).hitsByRule, input).toEqual({});
    }
  });

  it('runs in linear time on adversarial key runs', () => {
    expect(ms(() => scanSecrets('password="'.repeat(20_000)))).toBeLessThan(1000);
    expect(ms(() => scanSecrets('DB_PASSWORD='.repeat(20_000)))).toBeLessThan(1000);
    expect(ms(() => scanSecrets('password: '.repeat(20_000)))).toBeLessThan(1000);
    expect(ms(() => scanSecrets('\npassword = '.repeat(20_000)))).toBeLessThan(1000);
    expect(ms(() => scanSecrets('\\"password\\": \\"'.repeat(15_000)))).toBeLessThan(1000);
    expect(ms(() => scanSecrets('password: ' + 'a'.repeat(200_000)))).toBeLessThan(1000);
    expect(ms(() => scanSecrets(('password: ' + 'a b '.repeat(200) + '\n').repeat(200)))).toBeLessThan(1000);
    expect(ms(() => redact('token:"x'.repeat(20_000)))).toBeLessThan(1000);
  });
});
