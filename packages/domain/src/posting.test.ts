import { describe, expect, it } from 'vitest';
import { RATE_LIMITS, postingPlan, takeToken, type PostingInput } from './index.js';

const input = (over: Partial<PostingInput> = {}): PostingInput => ({
  shareMode: 'stats',
  hasTeam: true,
  policyAccepted: false,
  holdMinutes: 30,
  privateRepo: false,
  headless: false,
  warmup: false,
  source: 'captured',
  ...over,
});

describe('postingPlan', () => {
  it('stats mode: stats auto-post to the team; distilled text is an owner draft', () => {
    expect(postingPlan(input())).toEqual({ stats: 'auto_post', statsVisibility: 'team', distilled: 'owner_draft', holdMinutes: null, distill: true });
  });

  it('off, warmups and agent-reported sources post nothing', () => {
    for (const over of [{ shareMode: 'off' as const }, { warmup: true }, { source: 'agent_reported' as const }]) {
      expect(postingPlan(input(over))).toMatchObject({ stats: 'none', distilled: 'none', distill: false });
    }
  });

  it('auto-team needs an accepted policy (and a team)', () => {
    expect(postingPlan(input({ shareMode: 'auto-team', policyAccepted: true }))).toMatchObject({ distilled: 'hold_then_publish', holdMinutes: 30 });
    expect(postingPlan(input({ shareMode: 'auto-team', policyAccepted: true, holdMinutes: 0 })).holdMinutes).toBe(30);
    expect(postingPlan(input({ shareMode: 'auto-team', policyAccepted: false })).distilled).toBe('owner_draft');
    expect(postingPlan(input({ shareMode: 'auto-team', policyAccepted: true, hasTeam: false })).distilled).toBe('owner_draft');
  });

  it('visibility: repo for private repos, team with a team, else private; never public', () => {
    expect(postingPlan(input({ privateRepo: true })).statsVisibility).toBe('repo');
    expect(postingPlan(input({ hasTeam: false })).statsVisibility).toBe('private');
    for (const headless of [true, false]) expect(postingPlan(input({ headless })).statsVisibility).not.toBe('public');
  });
});

describe('takeToken', () => {
  const now = 1_000_000;
  it('starts full and drains', () => {
    let r = takeToken(null, RATE_LIMITS.send_message, now);
    expect(r).toMatchObject({ allowed: true, retryAfterS: 0, state: { tokens: 29, updatedAt: now } });
    for (let i = 0; i < 29; i++) r = takeToken(r.state, RATE_LIMITS.send_message, now);
    expect(r.allowed).toBe(true);
    const denied = takeToken(r.state, RATE_LIMITS.send_message, now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterS).toBe(120); // 1 token per 3,600 s / 30
  });

  it('refills continuously, capped at capacity', () => {
    const empty = { tokens: 0, updatedAt: now };
    expect(takeToken(empty, RATE_LIMITS.ingest, now + 4_999).allowed).toBe(false);
    expect(takeToken(empty, RATE_LIMITS.ingest, now + 5_000).allowed).toBe(true);
    expect(takeToken({ tokens: 0, updatedAt: now }, RATE_LIMITS.mcp, now + 10 * 60_000).state.tokens).toBe(59);
  });

  it('new accounts get the lower limit; costs above capacity never pass', () => {
    const r = takeToken(null, RATE_LIMITS.cross_owner_threads, now, { newAccount: true });
    expect(r.state.tokens).toBe(2);
    const big = takeToken(null, RATE_LIMITS.cross_owner_threads, now, { newAccount: true, cost: 4 });
    expect(big.allowed).toBe(false);
    expect(big.retryAfterS).toBe(86_400);
  });

  it('a clock going backwards does not refill', () => {
    const r = takeToken({ tokens: 0, updatedAt: now }, RATE_LIMITS.mcp, now - 60_000);
    expect(r.allowed).toBe(false);
    expect(r.state.updatedAt).toBe(now);
  });
});
