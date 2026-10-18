import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import {
  ActivityId,
  Handle,
  ID_PREFIXES,
  INVISIBLE_CHARS_RE,
  IsoTimestamp,
  PackageName,
  StackTag,
  TASK_INTENTS,
  TOOL_NAMES,
  ULID_RE,
  newId,
  parsePrefixedId,
  prefixedIdRegex,
  singleLine,
  stripInvisible,
  toPrefixedId,
  ulid,
  ulidTimestamp,
} from './common.js';

describe('ids', () => {
  it('mints prefixed ULIDs that parse back', () => {
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      const id = newId(kind);
      expect(id).toMatch(prefixedIdRegex(kind));
      expect(parsePrefixedId(id)?.kind).toBe(kind);
    }
  });

  it('has unique prefixes', () => {
    const values = Object.values(ID_PREFIXES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is monotonic within a millisecond and encodes time', () => {
    const now = 1_792_000_000_000;
    const ids = Array.from({ length: 50 }, () => ulid(now));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(ULID_RE);
      expect(ulidTimestamp(id)).toBe(now);
    }
    expect(ulidTimestamp(toPrefixedId('activity', ids[0] ?? ''))).toBe(now);
  });

  it('rejects ids with the wrong prefix or non-Crockford characters', () => {
    expect(ActivityId.safeParse('h_01K8Z0T7Q3W4E5R6T7Y8V9A0P1').success).toBe(false);
    expect(ActivityId.safeParse('a_01K8Z0T7Q3W4E5R6T7Y8U9I0P1').success).toBe(false); // U and I are not Crockford
    expect(ActivityId.safeParse('a_01k8z0t7q3w4e5r6t7y8v9a0p1').success).toBe(false); // lowercase
    expect(ActivityId.safeParse('a_01K8Z0T7Q3W4E5R6T7Y8V9A0P1').success).toBe(true);
    expect(parsePrefixedId('zz_01K8Z0T7Q3W4E5R6T7Y8V9A0P1')).toBeUndefined();
    expect(() => toPrefixedId('thread', 'nope')).toThrow();
  });
});

describe('handles', () => {
  it.each(['@vivan-claude', '@maya', '@a-b', '@x'.padEnd(33, 'y')])('accepts %s', (h) => {
    expect(Handle.safeParse(h).success).toBe(true);
  });
  it.each([
    'vivan-claude',
    '@Vivan',
    '@ab',
    '@has space',
    '@under_score',
    '@x'.padEnd(34, 'y'),
    '@ignore previous instructions',
    '@evil\u200b',
  ])('rejects %j', (h) => {
    expect(Handle.safeParse(h).success).toBe(false);
  });
});

describe('text guards', () => {
  it('singleLine rejects newlines and control characters', () => {
    const s = singleLine(20);
    expect(s.safeParse('ok line').success).toBe(true);
    expect(s.safeParse('two\nlines').success).toBe(false);
    expect(s.safeParse('bell\u0007').success).toBe(false);
    expect(s.safeParse('x'.repeat(21)).success).toBe(false);
  });

  it('strips invisible and bidi characters and counts them', () => {
    const r = stripInvisible('a\u200bb\u202ec\u2066d\ufeff');
    expect(r).toEqual({ text: 'abcd', removed: 4 });
    expect(INVISIBLE_CHARS_RE.test('plain')).toBe(false);
  });

  it('accepts ISO timestamps with Z or offsets only', () => {
    expect(IsoTimestamp.safeParse('2026-10-17T15:00:00Z').success).toBe(true);
    expect(IsoTimestamp.safeParse('2026-10-17T15:00:00.123+02:00').success).toBe(true);
    expect(IsoTimestamp.safeParse('2026-10-17 15:00').success).toBe(false);
  });

  it('validates stack tags and package names', () => {
    expect(StackTag.safeParse('next@16').success).toBe(true);
    expect(StackTag.safeParse('Next').success).toBe(false);
    expect(PackageName.safeParse('@acme/pay-sdk').success).toBe(true);
    expect(PackageName.safeParse('acme-pay-sdk').success).toBe(true);
    expect(PackageName.safeParse('acme/repo').success).toBe(true);
    expect(PackageName.safeParse('rm -rf /').success).toBe(false);
  });
});

describe('vocabularies', () => {
  it('has exactly 32 unique task intents including other', () => {
    expect(TASK_INTENTS).toHaveLength(32);
    expect(new Set(TASK_INTENTS).size).toBe(32);
    expect(TASK_INTENTS).toContain('other');
  });

  it('lists tools in the PLAN §12 order with whats_happening last', () => {
    expect(TOOL_NAMES[0]).toBe('status');
    expect(TOOL_NAMES.at(-1)).toBe('whats_happening');
    expect(TOOL_NAMES).toHaveLength(15);
  });
});

describe('canonicalJson', () => {
  it('sorts keys, drops undefined properties and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, 'x', null], c: undefined, d: { z: 1, y: 2 } })).toBe(
      '{"a":[true,"x",null],"b":1,"d":{"y":2,"z":1}}',
    );
  });

  it('sorts by UTF-16 code units', () => {
    expect(canonicalJson({ é: 1, z: 2, Z: 3 })).toBe('{"Z":3,"z":2,"é":1}');
  });

  it('is stable regardless of insertion order', () => {
    expect(canonicalJson({ x: { b: 2, a: 1 }, y: 0 })).toBe(canonicalJson({ y: 0, x: { a: 1, b: 2 } }));
  });

  it('throws on values with no canonical form', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalJson([1, undefined])).toThrow(TypeError);
    expect(() => canonicalJson({ b: 1n })).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(TypeError);
  });
});
