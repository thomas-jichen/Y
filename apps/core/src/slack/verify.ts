/** Slack request signatures (v0): HMAC-SHA256 over `v0:{ts}:{rawBody}`, 5-minute window, constant-time compare. */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SLACK_MAX_SKEW_S = 300;

export function verifySlackRequest(a: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowS: number;
}): boolean {
  const { timestamp, signature } = a;
  if (!a.signingSecret || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp) || !/^v0=[0-9a-f]{64}$/.test(signature)) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(a.nowS - ts) > SLACK_MAX_SKEW_S) return false;
  const expected = 'v0=' + createHmac('sha256', a.signingSecret).update(`v0:${timestamp}:${a.rawBody}`).digest('hex');
  const eb = Buffer.from(expected);
  const sb = Buffer.from(signature);
  return eb.length === sb.length && timingSafeEqual(eb, sb);
}

/** Build the headers Slack would send (tests and local tooling). */
export function signSlackRequest(signingSecret: string, rawBody: string, ts: number): Record<string, string> {
  const sig = 'v0=' + createHmac('sha256', signingSecret).update(`v0:${ts}:${rawBody}`).digest('hex');
  return { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig };
}
