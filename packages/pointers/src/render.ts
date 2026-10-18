/**
 * Rendering and grammar checks for push-path pointers (invariant I3).
 *
 * @module render
 */
import {
  PackageName,
  POINTER_PARAMS,
  POINTER_TEMPLATE_IDS,
  Pointer,
  SESSION_START_POINTER_BUDGET_CHARS,
  type PointerTemplateId,
} from '@y/schema';
import { FALLBACK_POINTER_TEXT, POINTER_PRIORITY, TEMPLATES, TEMPLATE_LOCALS, parseTemplate, templateGrammar } from './templates.js';

/**
 * Client-side values that never come from the network.
 * - `dependencies`: the client's own dependency names, indexed by P7's
 *   `depIndex` (the order the plugin used when matching claimed packages).
 */
export interface PointerLocals {
  dependencies?: readonly string[];
}

/** Options for {@link renderPointers}. */
export interface RenderPointersOptions {
  /** Max total characters (default 800, `SESSION_START_POINTER_BUDGET_CHARS`). */
  budgetChars?: number;
  locals?: PointerLocals;
}

/** Only these characters may ever appear in rendered output (printable ASCII; no control chars, no newlines). */
const SAFE_OUTPUT = /^[\x20-\x7E]+$/;

function resolveValues(templateId: PointerTemplateId, params: Record<string, unknown>, locals?: PointerLocals): Map<string, string> | null {
  const values = new Map<string, string>();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (typeof v === 'number') values.set(k, String(v));
    else if (typeof v === 'string') values.set(k, v);
    else return null;
  }
  for (const local of TEMPLATE_LOCALS[templateId] ?? []) {
    if (templateId === 'P7' && local === 'dependency') {
      const depIndex = params.dep_index;
      if (typeof depIndex !== 'number') return null;
      const dep = locals?.dependencies?.[depIndex];
      if (typeof dep !== 'string' || !PackageName.safeParse(dep).success) return null;
      values.set('dependency', dep);
    }
  }
  return values;
}

/**
 * Render one pointer.
 * 1. Validates `pointer` with the schema's `Pointer` (strict params).
 * 2. Resolves locals: P7's `{dependency}` = `locals.dependencies[depIndex]`,
 *    which must match the schema's `PackageName`.
 * 3. Substitutes params into the template (optional segments per the
 *    grammar).
 * Returns `null` (never throws) when validation fails or a required local is
 * missing; callers then print nothing (or {@link FALLBACK_POINTER_TEXT}).
 * The output always satisfies {@link isRenderedPointer}.
 */
export function renderPointer(pointer: Pointer, locals?: PointerLocals): string | null {
  try {
    const parsed = Pointer.safeParse(toWire(pointer));
    if (!parsed.success) return null;
    const { template_id: templateId, params } = parsed.data;
    const values = resolveValues(templateId, params as Record<string, unknown>, locals);
    if (!values) return null;
    let out = '';
    for (const t of parseTemplate(TEMPLATES[templateId])) {
      if (t.kind === 'text') out += t.text;
      else if (t.kind === 'ph') {
        const v = values.get(t.name);
        if (v === undefined) return null; // required placeholder missing
        out += v;
      } else {
        if (!t.parts.every((p) => p.kind === 'text' || values.has(p.name))) continue;
        out += t.parts.map((p) => (p.kind === 'text' ? p.text : (values.get(p.name) ?? ''))).join('');
      }
    }
    // Belt and braces: never emit anything the grammar does not accept.
    return isRenderedPointer(out) ? out : null;
  } catch {
    return null;
  }
}

const camelToSnake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Accept the legacy camelCase shape (`{templateId, params:{threadId}}`) by
 * mapping keys to the wire's snake_case; validation still happens against
 * the schema afterwards, so this never widens what renders.
 */
function toWire(pointer: unknown): unknown {
  if (pointer === null || typeof pointer !== 'object' || Array.isArray(pointer)) return pointer;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(pointer as Record<string, unknown>)) {
    if (k === 'params' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.params = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [camelToSnake(pk), pv]));
    } else out[camelToSnake(k)] = v;
  }
  return out;
}

function canonicalKey(pointer: Pointer): string {
  const p = toWire(pointer) as { template_id: unknown; params: unknown };
  const params = (p.params ?? {}) as Record<string, unknown>;
  const sorted = Object.keys(params)
    .sort()
    .map((k) => [k, params[k]]);
  return `${String(p.template_id)}:${JSON.stringify(sorted)}`;
}

/**
 * Render several pointers into one block for a push path: sort by
 * {@link POINTER_PRIORITY} (stable), drop exact duplicates, drop `P0` when
 * anything else renders, render each, and join with `\n` while the total
 * stays within `budgetChars` (a pointer that doesn't fit is skipped; later,
 * shorter ones may still fit). Unrenderable pointers are skipped. Returns
 * `''` when nothing fits.
 */
export function renderPointers(pointers: readonly Pointer[], opts?: RenderPointersOptions): string {
  const budget = opts?.budgetChars ?? SESSION_START_POINTER_BUDGET_CHARS;
  const idOf = (p: Pointer) => String((toWire(p) as { template_id?: unknown }).template_id);
  const rank = (p: Pointer) => {
    const i = POINTER_PRIORITY.indexOf(idOf(p) as PointerTemplateId);
    return i === -1 ? POINTER_PRIORITY.length : i;
  };
  const seen = new Set<string>();
  const ordered = (Array.isArray(pointers) ? [...pointers] : [])
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p !== null && typeof p === 'object')
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map(({ p }) => p)
    .filter((p) => {
      let key: string;
      try {
        key = canonicalKey(p);
      } catch {
        return false;
      }
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const rendered: { id: string; text: string }[] = [];
  for (const p of ordered) {
    const text = renderPointer(p, opts?.locals);
    if (text !== null) rendered.push({ id: idOf(p), text });
  }
  const anyNonP0 = rendered.some((r) => r.id !== 'P0');
  const lines: string[] = [];
  let total = 0;
  for (const r of anyNonP0 ? rendered.filter((x) => x.id !== 'P0') : rendered) {
    const add = r.text.length + (lines.length > 0 ? 1 : 0);
    if (total + add > budget) continue;
    lines.push(r.text);
    total += add;
  }
  return lines.join('\n');
}

function validPlaceholderValue(templateId: PointerTemplateId, name: string, raw: string): boolean {
  if (name === 'dependency') return PackageName.safeParse(raw).success;
  const field = (POINTER_PARAMS[templateId].shape as Record<string, { safeParse(v: unknown): { success: boolean } }>)[name];
  if (!field) return false;
  if (/^[0-9]+$/.test(raw)) {
    const n = Number(raw);
    if (String(n) === raw && field.safeParse(n).success) return true;
  }
  return field.safeParse(raw).success;
}

/**
 * Grammar check for the I3 fuzz test: true iff `text` is exactly one
 * rendering of some template, where every placeholder is filled with a value
 * its param schema allows (counts as decimal integers in range, ids by their
 * prefixed-ULID regex, handles by the handle regex, enums by their values,
 * `{dependency}` by the package-name regex) and optional segments are either
 * fully present or absent. Lines of a {@link renderPointers} block can be
 * checked one by one. Anything else (extra text, other placeholders, control
 * characters) is false.
 */
export function isRenderedPointer(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0 || text.length > 400 || !SAFE_OUTPUT.test(text)) return false;
  if (text === FALLBACK_POINTER_TEXT) return true;
  for (const templateId of POINTER_TEMPLATE_IDS) {
    const m = templateGrammar(templateId).exec(text);
    if (!m) continue;
    const groups = m.groups ?? {};
    const ok = Object.entries(groups).every(([name, raw]) => raw === undefined || validPlaceholderValue(templateId, name, raw));
    if (ok) return true;
  }
  return false;
}
