/**
 * Red-team #5 (round 2) at the DLP / L0 level: the secret-named-key rule in
 * @y/redact must not hold ordinary test summaries, ternaries, changelog
 * lines or ids, while real low-entropy key values are still caught.
 * Synthetic fixtures only.
 */
import { describe, expect, it } from 'vitest';
import { dlpScan, l0Scan } from './index.js';

describe('#5 secret-named keys through DLP and L0', () => {
  const benign = [
    'pass: 12 of 14 suites green',
    'Pass: 3 failing',
    '- pass: 40/40',
    "status = ok ? 'pass' : 'fail'",
    "{ pass: 'green', fail: 'red' }",
    'Fixed the login bug.\nPassword: reset flow now sends the email again.',
    'Password: must be 12+ chars',
    'password: see the vault',
    'token: gpt4o-mini-2024',
    'token: 2026-10-01',
    'auth: sha256',
    'auth: h_01HZXJ3K4M5N6P7Q8R9S0T1V2W',
  ];

  it('lets test summaries, ternaries, prose and ids through outbound DLP', () => {
    for (const body of benign) {
      const r = dlpScan(body, { allowShortCode: true });
      expect(r.findings.filter((f) => f.kind === 'secret'), body).toEqual([]);
    }
  });

  it('adds no secret findings to inbound L0 for the same text', () => {
    for (const body of benign) {
      expect(l0Scan(body, 'dm_teammate').findings.filter((f) => f.rule.startsWith('secret.')), body).toEqual([]);
    }
  });

  it('still holds a low-entropy password in a key-value body', () => {
    for (const body of ['"password": "Summer-sky"', 'DB_PASSWORD=CorrectHorseBatteryStaple', 'password: hunter two']) {
      const r = dlpScan(body, { allowShortCode: true });
      expect(r.ok, body).toBe(false);
      expect(r.findings.some((f) => f.kind === 'secret'), body).toBe(true);
    }
  });
});
