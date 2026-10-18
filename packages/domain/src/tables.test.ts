import { TOOL_NAMES, TOOL_POLICY } from '@y/schema';
import { describe, expect, it } from 'vitest';
import { QUALITY_WEIGHTS, RATE_LIMITS, WAKE_LIMITS } from './index.js';

describe('domain tables (contract)', () => {
  it('has a rate limit for every tool policy bucket', () => {
    for (const tool of TOOL_NAMES) expect(RATE_LIMITS).toHaveProperty(TOOL_POLICY[tool].rateLimit);
  });

  it('matches PLAN §10 rate limits', () => {
    expect(RATE_LIMITS.mcp).toMatchObject({ limit: 60, windowMs: 60_000 });
    expect(RATE_LIMITS.send_message).toMatchObject({ limit: 30, windowMs: 3_600_000 });
    expect(RATE_LIMITS.cross_owner_threads).toMatchObject({ limit: 10, newAccountLimit: 3 });
    expect(RATE_LIMITS.ingest).toMatchObject({ limit: 1, windowMs: 5_000, per: 'session' });
  });

  it('limits posting and scrolling (posts + go-scroll)', () => {
    expect(RATE_LIMITS.scroll_feed).toMatchObject({ limit: 20, windowMs: 3_600_000, per: 'agent' });
    expect(RATE_LIMITS.create_post).toMatchObject({ limit: 20, windowMs: 86_400_000, per: 'agent' });
    expect(RATE_LIMITS.create_post_owner).toMatchObject({ limit: 40, windowMs: 86_400_000, per: 'owner' });
    expect(RATE_LIMITS.post_comment).toMatchObject({ limit: 30, windowMs: 3_600_000, per: 'agent' });
    expect(RATE_LIMITS.post_react).toMatchObject({ limit: 60, windowMs: 3_600_000, per: 'agent' });
    expect(RATE_LIMITS.post_learn).toMatchObject({ limit: 30, windowMs: 3_600_000, per: 'agent' });
    expect(RATE_LIMITS.web_post_comment).toMatchObject({ limit: 30, windowMs: 3_600_000, per: 'owner' });
    expect(RATE_LIMITS.web_post_react).toMatchObject({ limit: 120, windowMs: 3_600_000, per: 'owner' });
  });

  it('matches PLAN §8/§9 weights and wake budget', () => {
    expect(QUALITY_WEIGHTS.kudos).toBe(0);
    expect(QUALITY_WEIGHTS.reportedHelped).toBe(0);
    expect(QUALITY_WEIGHTS.measuredHelp).toBe(2);
    expect(WAKE_LIMITS).toEqual({ recipientPerHour: 6, recipientPerDay: 30, senderPerHour: 3, coalesceMs: 20_000 });
  });
});
