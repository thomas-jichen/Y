import { POINTER_PARAMS, POINTER_TEMPLATE_IDS, TOOL_NAMES } from '@y/schema';
import { describe, expect, it } from 'vitest';
import { FALLBACK_POINTER_TEXT, POINTER_PRIORITY, TEMPLATES } from './index.js';

/** Placeholders a template may use beyond its params: client-side locals. */
const LOCALS: Record<string, readonly string[]> = { P7: ['dependency'] };

describe('TEMPLATES (contract)', () => {
  it('has one template per id and a full priority order', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([...POINTER_TEMPLATE_IDS].sort());
    expect([...POINTER_PRIORITY].sort()).toEqual([...POINTER_TEMPLATE_IDS].sort());
  });

  it.each(POINTER_TEMPLATE_IDS.map((id) => [id]))('%s only uses its own params or declared locals', (id) => {
    const template = TEMPLATES[id];
    const placeholders = [...template.matchAll(/\{([a-zA-Z_]+)\}/g)].map((m) => m[1]);
    const allowed = new Set([...Object.keys(POINTER_PARAMS[id].shape), ...(LOCALS[id] ?? [])]);
    for (const p of placeholders) expect(allowed.has(p ?? ''), `${id} uses {${p}}`).toBe(true);
    // Grammar characters appear only as grammar: balanced, non-nested optional segments.
    expect(template.replace(/\[[^[\]{}]*(?:\{[a-zA-Z_]+\}[^[\]{}]*)*\]/g, '').replace(/\{[a-zA-Z_]+\}/g, '')).not.toMatch(/[[\]{}]/);
  });

  it.each(POINTER_TEMPLATE_IDS.map((id) => [id]))('%s starts with "Y:" and names a next step', (id) => {
    const t = TEMPLATES[id];
    expect(t.startsWith('Y: ')).toBe(true);
    const namesTool = TOOL_NAMES.some((tool) => t.includes(tool)) || t.includes('/reload-skills');
    expect(namesTool).toBe(true);
    expect(t.length).toBeLessThan(200);
  });

  it('fallback names the inbox tool', () => {
    expect(FALLBACK_POINTER_TEXT).toContain('inbox');
  });
});
