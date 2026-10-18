/** Red-team regressions for @y/schema (#59 invisible characters, #60 prototype keys in stat maps). */
import { describe, expect, it } from 'vitest';
import { ActivityStats, INVISIBLE_CHARS_RE, emptyStats, mergeStats, stripInvisible, totalToolCalls } from './index.js';

describe('#59 INVISIBLE_CHARS_SOURCE', () => {
  it('covers CGJ, ALM, Hangul fillers, Khmer inherent vowels and Mongolian FVS', () => {
    for (const ch of ['͏', '؜', 'ᅟ', 'ᅠ', '឴', '឵', '᠋', '᠌', '᠍', '᠏', 'ㅤ', 'ﾠ']) {
      expect(INVISIBLE_CHARS_RE.test(`a${ch}b`), ch.codePointAt(0)?.toString(16)).toBe(true);
      expect(stripInvisible(`se${ch}nd`)).toEqual({ text: 'send', removed: 1 });
    }
  });

  it('leaves emoji variation selectors and ordinary text alone', () => {
    expect(stripInvisible('❤️ 한국어 مرحبا ᠮᠣᠩᠭᠣᠯ')).toEqual({ text: '❤️ 한국어 مرحبا ᠮᠣᠩᠭᠣᠯ', removed: 0 });
  });
});

describe('#60 stat maps keyed by Object.prototype member names', () => {
  const withCounts = (toolCalls: Record<string, number>, mcp: Record<string, Record<string, number>> = {}): ActivityStats => ({
    ...emptyStats(),
    toolCalls,
    mcp,
  });

  it('adds counters named toString / valueOf / constructor as numbers', () => {
    const acc = ActivityStats.parse(withCounts({ toString: 5, Bash: 1 }));
    const delta = ActivityStats.parse(withCounts({ toString: 2, valueOf: 3, constructor: 1 }));
    const merged = mergeStats(acc, delta);
    expect(merged.toolCalls).toEqual({ toString: 7, Bash: 1, valueOf: 3, constructor: 1 });
    expect(totalToolCalls(merged)).toBe(12);
    expect(ActivityStats.safeParse(merged).success).toBe(true);
  });

  it('never touches globals through MCP server/tool names, and keeps __proto__ as a plain key', () => {
    const keysBefore = Object.keys;
    // JSON.parse keeps "__proto__" as an own key (as a raw wire body would).
    const acc = { ...emptyStats(), ...JSON.parse('{"toolCalls":{"__proto__":0},"mcp":{}}') } as ActivityStats;
    const delta = { ...emptyStats(), ...JSON.parse('{"toolCalls":{"__proto__":3},"mcp":{"constructor":{"keys":4},"hasOwnProperty":{"toString":1}}}') } as ActivityStats;
    const merged = mergeStats(mergeStats(acc, delta), delta);
    expect(Object.keys).toBe(keysBefore);
    expect(typeof Object.keys).toBe('function');
    expect(JSON.parse(JSON.stringify(merged.toolCalls))).toEqual(JSON.parse('{"__proto__":6}'));
    expect(JSON.stringify(merged.mcp)).toBe('{"constructor":{"keys":8},"hasOwnProperty":{"toString":2}}');
    expect(Object.getPrototypeOf(merged.toolCalls)).toBe(Object.prototype);
    expect(totalToolCalls(merged)).toBe(16);
    expect(ActivityStats.safeParse(merged).success).toBe(true);
  });
});
