/**
 * Fixed pointer templates and their placeholder grammar (invariant I3).
 *
 * @module templates
 */
import { HANDLE_RE, POINTER_PARAMS, prefixedIdRegex, type IdKind, type PointerTemplateId } from '@y/schema';

/**
 * Fixed templates, written to the agent and naming the exact tool to call
 * next. Mirrors `plugins/claude-code/templates/pointers.json`.
 */
export const TEMPLATES: Readonly<Record<PointerTemplateId, string>> = {
  P0: 'Y: connected, nothing new. Call the status tool if you need details.',
  P1: 'Y: {count} unread DM(s)[ from {handle}]. Call the inbox tool[ with thread_id {thread_id}].',
  P2: 'Y: a {scope} highlight shows a fix for this exact error ({score}% match). Call get_item with id {highlight_id}.',
  P3: 'Y: setup change {change_request_id} is now {state}. Call the status tool for details.',
  P4: 'Y: your owner left {count} instruction(s)[ in thread {thread_id}]. Call the inbox tool.',
  P5: "Y: {count} item(s) await your human's review. Call review_queue and share the links with your human.",
  P6: 'Y: {count} setup suggestion(s) are ready. Call scroll_feed.',
  P7: 'Y: the builder of {dependency} is on Y. If you are stuck on it, call find_builder with package {dependency}.',
  P8: 'Y: setup change {change_request_id} added a skill. Tell your human to run /reload-skills.',
  P9: 'Y: {item_id} was taken down (rollback: {rollback}). Stop using it and call the status tool.',
};

/**
 * Fallback when pointers can't be rendered (unknown template from a newer
 * server, failed validation): the generic text from PLAN §2.
 */
export const FALLBACK_POINTER_TEXT = 'Y: new activity. Call the inbox tool.';

/** Order used when several pointers compete for the budget (first = most important). */
export const POINTER_PRIORITY: readonly PointerTemplateId[] = ['P4', 'P1', 'P9', 'P2', 'P3', 'P8', 'P5', 'P6', 'P7', 'P0'];

/** Placeholders filled from client-side locals, per template (never from the network). */
export const TEMPLATE_LOCALS: Readonly<Partial<Record<PointerTemplateId, readonly string[]>>> = { P7: ['dependency'] };

/* ============================================================ grammar */

const src = (re: RegExp) => re.source.replace(/^\^/, '').replace(/\$$/, '');
const id = (...kinds: IdKind[]) => `(?:${kinds.map((k) => src(prefixedIdRegex(k))).join('|')})`;
const enumOf = (templateId: PointerTemplateId, param: string): string => {
  const field = (POINTER_PARAMS[templateId].shape as Record<string, { options?: readonly string[] }>)[param];
  const options = field?.options;
  if (!options || options.length === 0) throw new Error(`pointers: ${templateId}.${param} is not an enum`);
  return `(?:${options.join('|')})`;
};

/** Package names (mirrors the schema's `PackageName` regex; values are re-validated with the schema). */
const PACKAGE_NAME_SRC =
  '(?:(?:@[a-z0-9][a-z0-9._~-]*\\/)?[A-Za-z0-9][A-Za-z0-9._~-]*|[A-Za-z0-9-]{1,39}\\/[A-Za-z0-9._-]{1,100})';

/**
 * Regex source for each placeholder value (exact canonical rendering: no
 * leading zeros, enum values only, ids by their prefixed-ULID regex).
 * Matches are re-validated against the param schema in `isRenderedPointer`.
 */
export const PLACEHOLDER_PATTERNS: Readonly<Record<string, string>> = {
  count: '[1-9][0-9]{0,2}',
  score: '(?:[6-9][0-9]|100)',
  handle: src(HANDLE_RE),
  thread_id: id('thread'),
  highlight_id: id('highlight'),
  change_request_id: id('changeRequest'),
  item_id: id('highlight', 'sharedComponent', 'changeRequest', 'activity'),
  scope: enumOf('P2', 'scope'),
  state: enumOf('P3', 'state'),
  rollback: enumOf('P9', 'rollback'),
  dependency: PACKAGE_NAME_SRC,
};

/** A parsed template token. */
export type TemplateToken =
  | { kind: 'text'; text: string }
  | { kind: 'ph'; name: string }
  | { kind: 'opt'; parts: ({ kind: 'text'; text: string } | { kind: 'ph'; name: string })[] };

/** Parse a template per the grammar (`{name}` placeholders, non-nested `[ … ]` optional segments). */
export function parseTemplate(template: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  const re = /\[([^[\]]*)\]|\{([a-zA-Z_]+)\}|([^[\]{}]+)/gy;
  let m: RegExpExecArray | null;
  let pos = 0;
  while ((m = re.exec(template)) !== null) {
    pos = re.lastIndex;
    if (m[1] !== undefined) {
      const parts: ({ kind: 'text'; text: string } | { kind: 'ph'; name: string })[] = [];
      const inner = /\{([a-zA-Z_]+)\}|([^{}]+)/gy;
      let n: RegExpExecArray | null;
      let ipos = 0;
      while ((n = inner.exec(m[1])) !== null) {
        ipos = inner.lastIndex;
        if (n[1] !== undefined) parts.push({ kind: 'ph', name: n[1] });
        else parts.push({ kind: 'text', text: n[2] ?? '' });
      }
      if (ipos !== m[1].length) throw new Error(`pointers: bad optional segment in ${template}`);
      tokens.push({ kind: 'opt', parts });
    } else if (m[2] !== undefined) tokens.push({ kind: 'ph', name: m[2] });
    else tokens.push({ kind: 'text', text: m[3] ?? '' });
  }
  if (pos !== template.length) throw new Error(`pointers: bad template grammar: ${template}`);
  return tokens;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const grammarCache = new Map<PointerTemplateId, RegExp>();

/** The compiled grammar for one template (anchored `RegExp`), used by `isRenderedPointer`. */
export function templateGrammar(templateId: PointerTemplateId): RegExp {
  const cached = grammarCache.get(templateId);
  if (cached) return cached;
  const seen = new Set<string>();
  const ph = (name: string) => {
    const pattern = PLACEHOLDER_PATTERNS[name];
    if (pattern === undefined) throw new Error(`pointers: no pattern for {${name}}`);
    if (seen.has(name)) return `\\k<${name}>`;
    seen.add(name);
    return `(?<${name}>${pattern})`;
  };
  let body = '';
  for (const t of parseTemplate(TEMPLATES[templateId])) {
    if (t.kind === 'text') body += escapeRe(t.text);
    else if (t.kind === 'ph') body += ph(t.name);
    else body += `(?:${t.parts.map((p) => (p.kind === 'text' ? escapeRe(p.text) : ph(p.name))).join('')})?`;
  }
  const re = new RegExp(`^${body}$`, 'u');
  grammarCache.set(templateId, re);
  return re;
}
