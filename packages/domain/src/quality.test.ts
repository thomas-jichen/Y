import { describe, expect, it } from 'vitest';
import {
  adoptionDelta,
  adoptionReady,
  creditWeight,
  leaderboardEligible,
  measuredHelp,
  quality,
  shouldQuarantineForFlags,
  wilson,
  type QualitySignals,
  type ToolEvent,
} from './index.js';

const zero: QualitySignals = { measuredHelp: 0, measuredFail: 0, rediscoveries: 0, kept7d: 0, rolledBack: 0, flags: 0 };

describe('quality', () => {
  it('no signals → 0.5', () => {
    expect(quality(zero)).toBe(0.5);
  });

  it('display-only signals weigh 0', () => {
    expect(quality({ ...zero, reportedHelped: 50, distillerHelped: 9, kudos: 1000, views: 1e6 })).toBe(0.5);
  });

  it('follows the logistic of the weighted sum', () => {
    expect(quality({ ...zero, measuredHelp: 2 })).toBeCloseTo(1 / (1 + Math.exp(-1)), 12);
    expect(quality({ ...zero, flags: 1 })).toBeCloseTo(1 / (1 + Math.exp(0.75)), 12);
  });

  it('is monotonic in positive and negative signals and stays in (0, 1)', () => {
    expect(quality({ ...zero, measuredHelp: 3 })).toBeGreaterThan(quality({ ...zero, measuredHelp: 1 }));
    expect(quality({ ...zero, kept7d: 1 })).toBeGreaterThan(0.5);
    expect(quality({ ...zero, rolledBack: 1 })).toBeLessThan(0.5);
    expect(quality({ ...zero, measuredFail: 1 })).toBeLessThan(0.5);
    const hi = quality({ ...zero, measuredHelp: 1e6 });
    expect(hi).toBeLessThanOrEqual(1);
    expect(quality({ ...zero, flags: 1e6 })).toBeGreaterThanOrEqual(0);
  });

  it('ignores negative and non-finite counts', () => {
    expect(quality({ ...zero, flags: -5, measuredHelp: Number.NaN })).toBe(0.5);
  });

  it('two distinct flaggers quarantine', () => {
    expect(shouldQuarantineForFlags(1)).toBe(false);
    expect(shouldQuarantineForFlags(2)).toBe(true);
  });
});

describe('measuredHelp', () => {
  const ev = (index: number, exitCode: number | null, commandKey = 'pnpm test'): ToolEvent => ({ index, commandKey, exitCode });
  const base = { exposureIndex: 10, failingCommandKey: 'pnpm test', sessionGreen: true };

  it('helped: same command exits 0 within 15 calls and the session ends green', () => {
    expect(measuredHelp({ ...base, events: [ev(12, 1), ev(14, 0, 'ls'), ev(18, 0)] })).toEqual({ outcome: 'helped', withinCalls: 8 });
    expect(measuredHelp({ ...base, events: [ev(25, 0)] })).toEqual({ outcome: 'helped', withinCalls: 15 });
  });

  it('outside the window or before the exposure does not count', () => {
    expect(measuredHelp({ ...base, events: [ev(26, 0)] }).outcome).toBe('inconclusive');
    expect(measuredHelp({ ...base, events: [ev(10, 0), ev(5, 0)] }).outcome).toBe('inconclusive');
  });

  it('failed: re-run never exits 0, or success without a green session', () => {
    expect(measuredHelp({ ...base, events: [ev(12, 1), ev(15, 2)] })).toEqual({ outcome: 'failed', withinCalls: null });
    expect(measuredHelp({ ...base, sessionGreen: false, events: [ev(12, 0)] }).outcome).toBe('failed');
  });

  it('a different command succeeding is inconclusive; unknown exit codes are ignored', () => {
    expect(measuredHelp({ ...base, events: [ev(12, 0, 'pnpm build')] }).outcome).toBe('inconclusive');
    expect(measuredHelp({ ...base, events: [ev(12, null)] }).outcome).toBe('inconclusive');
  });

  it('respects a custom window', () => {
    expect(measuredHelp({ ...base, window: 3, events: [ev(14, 0)] }).outcome).toBe('inconclusive');
    expect(measuredHelp({ ...base, window: 3, events: [ev(13, 0)] }).outcome).toBe('helped');
  });
});

describe('creditWeight', () => {
  const c = { creditorOwnerId: 'u_1', authorOwnerId: 'u_2', creditorAccountAgeDays: 30, sameTeamCreditsLast30d: 0 };
  it('same owner, young accounts and flagged pairs give 0', () => {
    expect(creditWeight({ ...c, authorOwnerId: 'u_1' })).toBe(0);
    expect(creditWeight({ ...c, creditorAccountAgeDays: 6.9 })).toBe(0);
    expect(creditWeight({ ...c, reciprocityFlagged: true })).toBe(0);
  });
  it('divides by √(same-team credits + 1)', () => {
    expect(creditWeight(c)).toBe(1);
    expect(creditWeight({ ...c, sameTeamCreditsLast30d: 3 })).toBe(0.5);
  });
});

describe('wilson / adoption / leaderboards', () => {
  it('wilson interval', () => {
    expect(wilson(0, 0)).toEqual({ lower: 0, upper: 1 });
    const w = wilson(8, 10);
    expect(w.lower).toBeCloseTo(0.4902, 3);
    expect(w.upper).toBeCloseTo(0.9433, 3);
    const all = wilson(5, 5);
    expect(all.upper).toBe(1);
    expect(all.lower).toBeGreaterThan(0.5);
  });

  it('adoptionReady', () => {
    expect(adoptionReady(3, 0)).toBe(true);
    expect(adoptionReady(2, 13)).toBe(false);
    expect(adoptionReady(1, 14)).toBe(true);
    expect(adoptionReady(0, 30)).toBe(false);
  });

  it('adoptionDelta compares success and median tokens', () => {
    const baseline = Array.from({ length: 12 }, (_, i) => ({ success: i % 2 === 0, tokens: 100_000 }));
    const post = [
      { success: true, tokens: 60_000 },
      { success: true, tokens: 70_000 },
      { success: true, tokens: 80_000 },
      { success: false, tokens: 10_000 },
    ];
    const d = adoptionDelta(baseline, post);
    expect(d.baselineN).toBe(10);
    expect(d.postN).toBe(4);
    expect(d.deltaSuccess).toBeCloseTo(0.25, 12);
    expect(d.deltaTokens).toBeCloseTo(-0.3, 12);
    expect(d.ci95[0]).toBeLessThan(d.deltaSuccess);
    expect(d.ci95[1]).toBeGreaterThan(d.deltaSuccess);
    expect(d.ci95[0]).toBeGreaterThanOrEqual(-1);
    expect(adoptionDelta([], []).deltaTokens).toBeNull();
  });

  it('leaderboardEligible', () => {
    expect(leaderboardEligible({ kind: 'organic', n: 5, owners: 3 })).toBe(true);
    expect(leaderboardEligible({ kind: 'organic', n: 5, owners: 2 })).toBe(false);
    expect(leaderboardEligible({ kind: 'organic', n: 4, owners: 9 })).toBe(false);
    expect(leaderboardEligible({ kind: 'verified', n: 1, owners: 1 })).toBe(true);
  });
});
