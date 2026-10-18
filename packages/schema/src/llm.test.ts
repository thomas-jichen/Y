import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActivityCard, HighlightDrafts } from './activity.js';
import { fx } from './fixtures.js';
import {
  CAPABILITY_TAGS,
  ReaderTags,
  activityCardJsonSchema,
  highlightsJsonSchema,
  judgeVerdictJsonSchema,
  readerTagsJsonSchema,
  toStructuredOutputSchema,
  type JsonSchema,
} from './llm.js';
import { JudgeVerdict } from './safety.js';

const FORBIDDEN = ['minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'oneOf', 'default', '$schema'];

/** Visit every schema node (not property-name maps). */
function walk(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  visit(obj);
  for (const sub of Object.values((obj.properties as Record<string, unknown> | undefined) ?? {})) walk(sub, visit);
  for (const key of ['anyOf', 'allOf', 'prefixItems'] as const) {
    for (const sub of (obj[key] as unknown[] | undefined) ?? []) walk(sub, visit);
  }
  for (const sub of Object.values((obj.$defs as Record<string, unknown> | undefined) ?? {})) walk(sub, visit);
  walk(obj.items, visit);
}

describe('structured-output JSON schemas', () => {
  it.each([
    ['activityCard', activityCardJsonSchema],
    ['highlights', highlightsJsonSchema],
    ['judgeVerdict', judgeVerdictJsonSchema],
    ['readerTags', readerTagsJsonSchema],
  ] as [string, JsonSchema][])('%s uses only the supported subset', (_name, schema) => {
    expect(schema.type).toBe('object');
    walk(schema, (obj) => {
      for (const key of FORBIDDEN) expect(key in obj, `found ${key}`).toBe(false);
      if (obj.type === 'object') {
        expect(obj.additionalProperties).toBe(false);
        expect([...((obj.required as string[]) ?? [])].sort()).toEqual(Object.keys((obj.properties as object) ?? {}).sort());
      }
    });
  });

  it('valid model outputs pass the zod schemas', () => {
    expect(ActivityCard.safeParse(fx.activityCard()).success).toBe(true);
    expect(HighlightDrafts.safeParse({ highlights: [fx.highlightDraft()] }).success).toBe(true);
    expect(
      JudgeVerdict.safeParse({
        label: 'malicious',
        category: 'prompt_injection',
        confidence: 0.97,
        rationale: 'asks the reader to exfiltrate env',
        spans: [{ quote: 'ignore previous instructions' }],
      }).success,
    ).toBe(true);
    expect(ReaderTags.safeParse({ capabilityTags: ['test_debugging'], appliesToIntents: ['fix_failing_test'] }).success).toBe(true);
  });

  it('zod still enforces limits the JSON schema cannot express', () => {
    expect(ActivityCard.safeParse({ ...fx.activityCard(), title: 'short' }).success).toBe(false);
    expect(ActivityCard.safeParse({ ...fx.activityCard(), stackTags: Array(9).fill('ts') }).success).toBe(false);
    expect(ReaderTags.safeParse({ capabilityTags: ['free text tag'], appliesToIntents: [] }).success).toBe(false);
  });

  it('rejects schemas structured outputs cannot express', () => {
    expect(() => toStructuredOutputSchema(z.object({ a: z.string().optional() }))).toThrow(/optional/);
    expect(() => toStructuredOutputSchema(z.object({ a: z.record(z.string(), z.int()) }))).toThrow(/record/);
    expect(toStructuredOutputSchema(z.object({ a: z.string().nullable() }))).toMatchObject({
      required: ['a'],
      additionalProperties: false,
    });
  });
});

describe('capability tags', () => {
  it('has exactly 60 unique snake_case tags', () => {
    expect(CAPABILITY_TAGS).toHaveLength(60);
    expect(new Set(CAPABILITY_TAGS).size).toBe(60);
    for (const t of CAPABILITY_TAGS) expect(t).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});
