import { describe, expect, it } from 'vitest';
import { embeddingTextFor, normalizeQuery } from './index.js';

describe('embeddingTextFor', () => {
  it('highlight: title, summary, problem, tags, search queries', () => {
    const text = embeddingTextFor({
      kind: 'highlight',
      highlight: {
        title: ' Fix vitest ESM mocks ',
        summary: 'vi.mock hoisting breaks with top-level await',
        body: { problem: 'Tests fail with ReferenceError after upgrading.' },
        tags: ['vitest@3', 'typescript'],
      },
      searchQueries: ['ReferenceError: Cannot access before initialization', '  '],
    });
    expect(text).toBe(
      'Fix vitest ESM mocks\nvi.mock hoisting breaks with top-level await\nTests fail with ReferenceError after upgrading.\nvitest@3 typescript\nReferenceError: Cannot access before initialization',
    );
  });

  it('activity: never anything but title, summary, intent and tags', () => {
    expect(embeddingTextFor({ kind: 'activity', title: '38 tool calls · tests green', taskIntent: 'fix_failing_test', stackTags: ['vitest'] })).toBe(
      '38 tool calls · tests green\nfix failing test\nvitest',
    );
    const withDigest = { kind: 'activity' as const, title: 't', taskIntent: 'refactor' as const, stackTags: [], digest: 'SECRET DIGEST' };
    expect(embeddingTextFor(withDigest)).not.toContain('SECRET');
  });

  it('component: name, capability tags, content capped at 6,000; total capped at 8,000', () => {
    const t = embeddingTextFor({ kind: 'component', componentKind: 'skill', name: 'vitest-fixer', capabilityTags: ['testing', 'debugging'], content: 'x'.repeat(10_000) });
    expect(t.startsWith('vitest-fixer\ntesting debugging\nxxx')).toBe(true);
    expect(t.length).toBe('vitest-fixer\ntesting debugging\n'.length + 6000);
    const long = embeddingTextFor({ kind: 'highlight', highlight: { title: 'a', summary: 'b', body: { problem: 'c' }, tags: [] }, searchQueries: Array(20).fill('q'.repeat(500)) });
    expect(long.length).toBe(8000);
  });
});

describe('normalizeQuery', () => {
  it('strips ANSI, invisible and control characters and collapses whitespace', () => {
    expect(normalizeQuery('\u001b[31mError:\u001b[0m  boom\u200b\n\tnow')).toBe('Error: boom now');
  });

  it('removes machine-specific noise so the same error matches across machines', () => {
    const a = normalizeQuery("TypeError: Cannot read properties of undefined (reading 'map') at /Users/maya/code/web/src/List.tsx:12:5");
    const b = normalizeQuery("TypeError: Cannot read properties of undefined (reading 'map') at /home/vivan/code/web/src/List.tsx:40:17");
    expect(a).toBe(b);
    expect(a).toBe("TypeError: Cannot read properties of undefined (reading 'map') at ~/code/web/src/List.tsx");
    expect(normalizeQuery('C:\\Users\\Bob\\proj\\a.py:3 failed')).toBe('~/proj\\a.py failed');
  });

  it('replaces ids, timestamps, addresses and long numbers', () => {
    expect(normalizeQuery('job 0f8fad5b-d9cb-469f-a165-70867728950e failed at 2026-10-17T12:00:01.123Z (0x7ffee3b0a8c0) pid 123456')).toBe(
      'job <uuid> failed at <ts> (0x<addr>) pid <n>',
    );
    expect(normalizeQuery('exit code 1 on port 5432')).toBe('exit code 1 on port 5432');
  });

  it('is NFKC-normalized, idempotent and capped on a code-point boundary', () => {
    expect(normalizeQuery('ｅｒｒｏｒ')).toBe('error');
    const q = 'ERR_MODULE_NOT_FOUND at /Users/x/a.ts:1:1';
    expect(normalizeQuery(normalizeQuery(q))).toBe(normalizeQuery(q));
    expect(normalizeQuery('😀'.repeat(600))).toBe('😀'.repeat(500));
    expect(normalizeQuery('abc def', { maxChars: 4 })).toBe('abc');
    expect(normalizeQuery(' \n ')).toBe('');
  });
});
