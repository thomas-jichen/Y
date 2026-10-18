import { emptyStats, type ActivityStats } from '@y/schema';
import { describe, expect, it } from 'vitest';
import { compactCount, isWarmup, segmentKey, sizeBucketFor, templatedTitle, totalToolCalls } from './index.js';

function stats(over: { calls?: number; mcpCalls?: number; tokens?: number; testsRan?: boolean; green?: boolean; wallMs?: number } = {}): ActivityStats {
  const s = emptyStats('2.1.0');
  s.toolCalls = over.calls ? { Bash: Math.ceil(over.calls / 2), Edit: Math.floor(over.calls / 2) } : {};
  s.mcp = over.mcpCalls ? { y: { search_network: over.mcpCalls } } : {};
  s.tokens = { ...s.tokens, total: over.tokens ?? 0 };
  s.tests = { runs: over.testsRan ? 2 : 0, greenAtEnd: over.green ?? false, confidence: 0.9 };
  s.wallMs = over.wallMs ?? 600_000;
  return s;
}

describe('templatedTitle', () => {
  it('matches the PLAN example', () => {
    const s = stats({ calls: 36, mcpCalls: 2, tokens: 212_000, testsRan: true, green: true });
    expect(templatedTitle(s, { model: 'claude-opus-5-5' }, { stackTags: ['next@16', 'react'] })).toBe('38 tool calls · 212k tokens · tests green · next@16');
  });

  it('omits unknown tokens and tests that did not run; falls back to the model', () => {
    expect(templatedTitle(stats({ calls: 1 }), { model: 'claude-opus-5-5' })).toBe('1 tool call · opus-5-5');
    expect(templatedTitle(stats({ calls: 38, testsRan: true, green: true }), { model: 'x' }, { stackTags: ['next@16'] })).toBe('38 tool calls · tests green · next@16');
    expect(templatedTitle(stats({ calls: 4, testsRan: true, green: false }), { model: 'claude-sonnet-5-5' })).toBe('4 tool calls · tests red · sonnet-5-5');
  });

  it('never contains free text and stays ≤ 120 chars', () => {
    const t = templatedTitle(stats({ calls: 10 }), { model: 'claude-opus-5-5' }, { stackTags: [] });
    expect(t.length).toBeLessThanOrEqual(120);
    // A model id with odd characters is dropped rather than echoed.
    expect(templatedTitle(stats({ calls: 2 }), { model: 'weird:model/[x]' })).toBe('2 tool calls');
  });
});

describe('compactCount', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1_000, '1k'],
    [1_500, '1.5k'],
    [9_960, '10k'],
    [212_000, '212k'],
    [999_499, '999k'],
    [999_500, '1M'],
    [1_250_000, '1.3M'],
    [14_000_000, '14M'],
  ])('%d → %s', (n, s) => expect(compactCount(n)).toBe(s));
});

describe('size buckets and warmups', () => {
  it('counts MCP calls in the total', () => {
    expect(totalToolCalls(stats({ calls: 4, mcpCalls: 3 }))).toBe(7);
  });
  it('S / M / L', () => {
    expect(sizeBucketFor(stats({ calls: 19, tokens: 99_999 }))).toBe('S');
    expect(sizeBucketFor(stats({ calls: 20, tokens: 0 }))).toBe('M');
    expect(sizeBucketFor(stats({ calls: 5, tokens: 100_000 }))).toBe('M');
    expect(sizeBucketFor(stats({ calls: 80 }))).toBe('L');
    expect(sizeBucketFor(stats({ calls: 2, tokens: 1_000_000 }))).toBe('L');
  });
  it('warmup: < 3 tool calls or < 2 min wall time', () => {
    expect(isWarmup(stats({ calls: 2 }))).toBe(true);
    expect(isWarmup(stats({ calls: 10, wallMs: 119_999 }))).toBe(true);
    expect(isWarmup(stats({ calls: 3, wallMs: 120_000 }))).toBe(false);
  });
});

describe('segmentKey', () => {
  it('prefers test runners, then frameworks, then languages', () => {
    expect(segmentKey({ intent: 'fix_failing_test', stackTags: ['typescript', 'next@16', 'vitest@3'], sizeBucket: 'M' })).toEqual({
      slug: 'fix-failing-test-vitest',
      intent: 'fix_failing_test',
      stackKey: 'vitest',
      majorVersion: '3',
      sizeBucket: 'M',
    });
    expect(segmentKey({ intent: 'upgrade_framework', stackTags: ['typescript', 'next@16.1'], sizeBucket: 'L' })).toMatchObject({
      slug: 'upgrade-framework-next',
      majorVersion: '16',
    });
    expect(segmentKey({ intent: 'refactor', stackTags: ['python'], sizeBucket: 'S' }).slug).toBe('refactor-python');
  });
  it('falls back to the first tag, then general; slugs are URL-safe', () => {
    expect(segmentKey({ intent: 'cleanup', stackTags: ['obscure-lib@2'], sizeBucket: 'S' })).toMatchObject({ stackKey: 'obscure-lib', majorVersion: '2' });
    expect(segmentKey({ intent: 'cleanup', stackTags: [], sizeBucket: 'S' })).toMatchObject({ slug: 'cleanup-general', stackKey: 'general', majorVersion: null });
    expect(segmentKey({ intent: 'refactor', stackTags: ['c++'], sizeBucket: 'S' }).slug).toBe('refactor-cpp');
    expect(segmentKey({ intent: 'refactor', stackTags: ['c#'], sizeBucket: 'S' }).slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});
