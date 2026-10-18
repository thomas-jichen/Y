import { describe, expect, it } from 'vitest';
import { signSlackRequest, verifySlackRequest } from './verify.js';

const secret = 'test-signing-secret-0000000000000000';
const body = 'token=x&team_id=T0TEST001&text=connect';
const now = 1_767_225_600;

function args(over: Partial<Parameters<typeof verifySlackRequest>[0]> = {}) {
  const h = signSlackRequest(secret, body, now);
  return { signingSecret: secret, timestamp: h['x-slack-request-timestamp'], signature: h['x-slack-signature'], rawBody: body, nowS: now, ...over };
}

describe('verifySlackRequest', () => {
  it('accepts a valid signature', () => {
    expect(verifySlackRequest(args())).toBe(true);
  });
  it('rejects the wrong secret and a tampered body', () => {
    expect(verifySlackRequest(args({ signingSecret: 'another-secret-000000000000000000' }))).toBe(false);
    expect(verifySlackRequest(args({ rawBody: body + '&x=1' }))).toBe(false);
  });
  it('enforces the 5-minute window both ways', () => {
    expect(verifySlackRequest(args({ nowS: now + 300 }))).toBe(true);
    expect(verifySlackRequest(args({ nowS: now + 301 }))).toBe(false);
    expect(verifySlackRequest(args({ nowS: now - 301 }))).toBe(false);
  });
  it('rejects malformed headers without throwing', () => {
    expect(verifySlackRequest(args({ timestamp: undefined }))).toBe(false);
    expect(verifySlackRequest(args({ signature: undefined }))).toBe(false);
    expect(verifySlackRequest(args({ timestamp: '17x' }))).toBe(false);
    expect(verifySlackRequest(args({ signature: 'v0=abc' }))).toBe(false);
    expect(verifySlackRequest(args({ signature: 'v1=' + 'a'.repeat(64) }))).toBe(false);
    expect(verifySlackRequest(args({ signature: 'v0=' + 'a'.repeat(64) }))).toBe(false);
    expect(() => verifySlackRequest(args({ signature: 'v0=' + 'é'.repeat(64) }))).not.toThrow();
  });
});
