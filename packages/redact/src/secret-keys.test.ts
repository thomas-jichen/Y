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
      'secret_name', 'password_hash', 'bypass', 'compass', 'oauth', 'keyboard', 'apiKeyType', 'PASSWORD_RESET_URL', 'pwd', 'pass', 'PASS']) {
      expect(secretKeyKind(key), key).toBeUndefined();
    }
    for (const key of ['password', 'DB_PASSWORD', 'PGPASSWORD', 'adminPasswd', 'db_pwd', 'DB_PASS', 'secret', 'clientSecret', 'api_key', 'apiKey',
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
    expect(ms(() => scanSecrets('DB_PASSWORD=' + '()'.repeat(100_000)))).toBeLessThan(1000);
    expect(ms(() => scanSecrets(' DB_PASS=a(b)'.repeat(20_000)))).toBeLessThan(1000);
    expect(ms(() => scanSecrets("ok ? 'password' : ".repeat(20_000)))).toBeLessThan(1000);
    expect(ms(() => scanSecrets(('\nPASSWORD_PROD_2 = ' + 'w '.repeat(250)).repeat(400)))).toBeLessThan(1000);
  });
});

describe('#5 secret-named keys: status words, prose, ids and literal .env values', () => {
  it('does not treat a bare pass / PASS / pwd, or ternary and case labels, as secret keys', () => {
    for (const input of [
      "ok ? 'pass' : 'fail'",
      "ok ? 'PASS' : 'FAIL'",
      "res.status(ok ? 'pass' : 'error')",
      "`# ${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.tap.passed}/${total} passed`",
      "{ pass: 'green', fail: 'red' }",
      '"pass": "check"',
      'pass: green',
      'pass: 76/76',
      '- pass: 40/40',
      'Pass: 3 failing',
      'pass: 12 of 14 suites green',
      'pass: Summary of the fix',
      'tests_pass: Summer-sky1',
      'PWD=/Users/someone/proj',
      "case 'token': return 'abc123def';",
      "mode = ok ? 'token' : 'abc123def'",
    ]) {
      expect(scanSecrets(input), input).toEqual([]);
    }
  });

  it('does not treat prose after a password key as a password', () => {
    for (const input of [
      'Password: must be 8+ chars',
      'password: see the vault',
      'Password: reset it via the web app',
      '- password: Use a strong one',
      'Password: Hashing with bcrypt',
      'password: hashed',
      'Fixed the login bug.\nPassword: reset flow now sends the email again.',
      'password = salt + pepper',
      'password: hash',
    ]) {
      expect(scanSecrets(input), input).toEqual([]);
    }
  });

  it('keeps ids, dates, counters, model names and algorithm names after token / auth keys', () => {
    for (const input of [
      'auth: h_01HZXJ3K4M5N6P7Q8R9S0T1V2W',
      'token: 2026-10-01',
      'token: 1234567',
      'MAX_TOKEN=4096000',
      'auth: sha256',
      'token: gpt4o-mini-2024',
      '"auth": "hs256"',
      ' * Secret:   supabase secrets set Y_EMBED_SECRET=<random, >= 32 chars>',
      '"api_key": "string"',
      '"secret": "GITHUB_TOKEN"',
      '"secret": "default"',
    ]) {
      expect(scanSecrets(input), input).toEqual([]);
    }
  });

  it('redacts .env and INI values with punctuation or spaces whole, never in part', () => {
    for (const [input, value] of [
      ['DB_PASSWORD=Summer(sky)', 'Summer(sky)'],
      ['DB_PASSWORD=Summer,Sky', 'Summer,Sky'],
      ['DB_PASSWORD=Summer&Sky', 'Summer&Sky'],
      ['DB_PASSWORD=Summer<sky>', 'Summer<sky>'],
      ['(API_TOKEN=abc123def)', 'abc123def'],
      ['password = hunter two', 'hunter two'],
      ['password=hunter two', 'hunter two'],
    ] as const) {
      const r = redact(input);
      expect(r.text, input).toBe(input.replace(value, '<REDACTED:generic_assignment>'));
      expect(r.hitsByRule, input).toEqual({ generic_assignment: 1 });
    }
  });

  it('matches placeholders as whole words, so passwords containing "here" or "test" are redacted', () => {
    for (const [input, value] of [
      ['"password": "Sphere-Lantern"', 'Sphere-Lantern'],
      ['"password": "Attest-Blue"', 'Attest-Blue'],
    ] as const) {
      expect(redact(input).text, input).not.toContain(value);
    }
    for (const input of ['"password": "your-pw-here"', '"password": "test-only"', '"password": "changeme123"', '"password": "yourPasswordHere"']) {
      expect(scanSecrets(input), input).toEqual([]);
    }
  });

  it('redacts digit-free secret and key values when quoted or in the env form', () => {
    for (const [input, value] of [
      ['"client_secret": "SummerSkyBlue"', 'SummerSkyBlue'],
      ["private_key = 'SummerSkyBlue'", 'SummerSkyBlue'],
      ['API_KEY=SummerSkyBlue', 'SummerSkyBlue'],
    ] as const) {
      expect(redact(input).text, input).not.toContain(value);
    }
    // Tokens and auth values still need a digit; unquoted line values too.
    for (const input of ['"token": "SummerSkyBlue"', 'auth: "SummerSkyBlue"', 'client_secret: SummerSkyBlue', 'secret: Buffer']) {
      expect(scanSecrets(input), input).toEqual([]);
    }
  });

  it('classifies keys with environment, role and number suffixes', () => {
    for (const key of ['DB_PASSWORD_PROD', 'password_prod', 'PASSWORD_2', 'api_key_value', 'DB_PASS_STAGING', 'jwtSecretDev']) {
      expect(secretKeyKind(key), key).toBeDefined();
    }
    for (const key of ['token_count', 'password_min_length', 'key_value', 'pass_1', 'PASSWORD_RESET_URL']) {
      expect(secretKeyKind(key), key).toBeUndefined();
    }
    for (const [input, value] of [
      ['DB_PASSWORD_PROD=Summersky', 'Summersky'],
      ['"password_prod": "Summer-sky"', 'Summer-sky'],
      ['PASSWORD_2=Summersky', 'Summersky'],
    ] as const) {
      expect(redact(input).text, input).not.toContain(value);
    }
  });
});
