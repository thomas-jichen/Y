/**
 * Normalization of third-party text (PLAN §10 L0, step 0).
 *
 * @module normalize
 */
import { INVISIBLE_CHARS_SOURCE } from '@y/schema';

/** Result of {@link normalizeUntrusted}. */
export interface NormalizedText {
  text: string;
  /** Number of invisible / bidi-control / tag characters removed. */
  removedInvisible: number;
  /** Number of hidden constructs removed (HTML comments, markdown/HTML images). */
  removedHidden: number;
  /** Number of delimiter look-alikes escaped (`<untrusted…`, `</y…`). */
  escapedDelimiters: number;
  /** True if anything changed. */
  changed: boolean;
}

/** Internal: normalization plus the text that was hidden from a human reader (for L0 to scan). */
export interface NormalizedDetail extends NormalizedText {
  /** Hidden payloads: HTML comment bodies, image alt/URLs, decoded tag characters, bidi-reversed runs. */
  hidden: string[];
  /** Zero-width joiners removed (emoji sequences); not on their own a signal. */
  removedZwj: number;
}

const INVISIBLE_G = new RegExp(INVISIBLE_CHARS_SOURCE, 'g');
/** Unicode "tag" characters (ASCII smuggling), U+E0000–U+E007F. */
const TAG_CHARS_G = /[\u{E0000}-\u{E007F}]+/gu;
/** Bidi override runs: RLO/LRO … PDF (or end of line). */
const BIDI_RUN_G = /[‭‮]([^‬\n]*)/g;
/** C0 controls except tab and LF, DEL, and C1 controls. */
const CONTROLS_G = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const HTML_COMMENT_G = /<!--([\s\S]*?)(?:-->|$)/g;
/**
 * Max removal passes for nested hidden constructs. Each pass is linear; past
 * the cap, whatever hidden construct is left goes to `hidden` as a whole.
 */
const HIDDEN_PASSES_MAX = 4;

/** Next index ≥ i of either stop character (or `text.length`), for every i. */
function nextStops(text: string, a: string, b: string): Int32Array {
  const n = text.length;
  const out = new Int32Array(n + 1);
  out[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const c = text[i];
    out[i] = c === a || c === b ? i : (out[i + 1] ?? n);
  }
  return out;
}

/**
 * `text.replace(/!\[([^\]\n]*)\]\(([^)\n]*)\)/g, …)` in linear time (the
 * regex restarts its `[^\]\n]*` scan at every `![`, quadratic on `![![![…`).
 * The classes can't contain their closing character, so each candidate has
 * exactly one possible match: the same matches as the regex.
 */
function replaceMdImages(text: string, onMatch: (alt: string, url: string) => void): string {
  if (!text.includes('![')) return text;
  const n = text.length;
  const rb = nextStops(text, ']', '\n');
  const rp = nextStops(text, ')', '\n');
  let out = '';
  let copied = 0;
  let i = 0;
  for (let p = text.indexOf('![', i); p >= 0; p = text.indexOf('![', i)) {
    const q = rb[p + 2] ?? n;
    if (q < n && text[q] === ']' && text[q + 1] === '(') {
      const r = rp[q + 2] ?? n;
      if (r < n && text[r] === ')') {
        onMatch(text.slice(p + 2, q), text.slice(q + 2, r));
        out += text.slice(copied, p);
        copied = r + 1;
        i = r + 1;
        continue;
      }
    }
    i = p + 1;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** `text.replace(/<img\b[^>]*>/gi, …)` in linear time (the regex rescans to the next `>` from every `<img`). */
function replaceHtmlImgs(text: string, onMatch: (tag: string) => void): string {
  const open = /<img/gi;
  if (!open.test(text)) return text;
  let out = '';
  let copied = 0;
  let gt = -2; // cached `text.indexOf('>', from)` (−1: none left)
  open.lastIndex = 0;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const p = m.index;
    open.lastIndex = p + 1;
    const after = text[p + 4];
    if (after !== undefined && /\w/.test(after)) continue; // `\b` after `img`
    if (gt !== -1 && gt < p + 4) gt = text.indexOf('>', p + 4);
    if (gt === -1) break;
    onMatch(text.slice(p, gt + 1));
    out += text.slice(copied, p);
    copied = gt + 1;
    open.lastIndex = gt + 1;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** Whether any hidden construct is left (same patterns as the removal pass). */
function hasHiddenConstruct(text: string): boolean {
  let found = false;
  const hit = () => {
    found = true;
  };
  replaceMdImages(text, hit);
  if (!found) replaceHtmlImgs(text, hit);
  return found || text.includes('<!--');
}
const DELIMITER_G = /<(\/?)(\s*)(untrusted|y)/gi;
/** U+2039 SINGLE LEFT-POINTING ANGLE QUOTATION MARK: NFKC-stable look-alike for `<`. */
const ESCAPED_LT = '‹';

/** Full normalization with the hidden payloads (used by the cascade). */
export function normalizeDetailed(input: string): NormalizedDetail {
  const original = typeof input === 'string' ? input : String(input ?? '');
  const hidden: string[] = [];
  let removedInvisible = 0;
  let removedHidden = 0;
  let removedZwj = 0;
  let escapedDelimiters = 0;

  // 1. NFKC (fullwidth `＜!--` becomes `<!--` before we look for it).
  let text = original.normalize('NFKC');

  // 2a. Bidi-override runs: keep the visually-displayed (reversed) reading for scanning.
  for (const m of text.matchAll(BIDI_RUN_G)) if (m[1]) hidden.push([...m[1]].reverse().join(''));
  // 2b. Tag characters decode to ASCII; strip them.
  text = text.replace(TAG_CHARS_G, (run) => {
    const chars = [...run];
    removedInvisible += chars.length;
    const decoded = chars
      .map((c) => (c.codePointAt(0) ?? 0) - 0xe0000)
      .filter((cp) => cp >= 0x20 && cp < 0x7f)
      .map((cp) => String.fromCharCode(cp))
      .join('');
    if (decoded) hidden.push(decoded);
    return '';
  });
  // 2c. Invisible and bidi-control characters.
  text = text.replace(INVISIBLE_G, (ch) => {
    removedInvisible += 1;
    if (ch === '‍') removedZwj += 1;
    return '';
  });

  // 3. Line endings and control characters.
  text = text.replace(/\r\n?/g, '\n').replace(CONTROLS_G, '');

  // 4. Hidden constructs: HTML comments, markdown images, <img> tags. Removing
  //    one can join its neighbours into another (`<!![](x)-- … -->`), so repeat
  //    until nothing is removed (at most HIDDEN_PASSES_MAX linear passes); past
  //    the cap, whatever is left is also treated as hidden (scanned with the
  //    never-downgraded hidden rules).
  for (let pass = 0; ; pass++) {
    const before = text;
    text = text.replace(HTML_COMMENT_G, (_m, body: string) => {
      removedHidden += 1;
      if (body.trim()) hidden.push(body);
      return '';
    });
    text = replaceMdImages(text, (alt, url) => {
      removedHidden += 1;
      hidden.push(`${alt} ${url}`.trim());
    });
    text = replaceHtmlImgs(text, (m) => {
      removedHidden += 1;
      hidden.push(m);
    });
    if (text === before) break;
    // Joining text can also join a base letter and a combining mark.
    text = text.normalize('NFKC');
    if (pass + 1 >= HIDDEN_PASSES_MAX) {
      if (hasHiddenConstruct(text)) hidden.push(text);
      break;
    }
  }

  // 5. Escape delimiter look-alikes so content can't close or open an envelope/pointer frame.
  text = text.replace(DELIMITER_G, (_m, slash: string, ws: string, word: string) => {
    escapedDelimiters += 1;
    return `${ESCAPED_LT}${slash}${ws}${word}`;
  });

  // 6. Collapse runs of more than 2 blank lines to 2.
  text = text.replace(/\n(?:[ \t]*\n){3,}/g, '\n\n\n');

  return {
    text,
    removedInvisible,
    removedHidden,
    escapedDelimiters,
    removedZwj,
    hidden,
    changed: text !== original,
  };
}

/**
 * Normalize third-party text before screening, storage for display, and
 * enveloping:
 * 1. Unicode NFKC;
 * 2. strip invisible and bidi-control characters (`INVISIBLE_CHARS_SOURCE`
 *    in `@y/schema`) and Unicode tag characters (U+E0000–E007F);
 * 3. CRLF/CR → LF; remove C0 controls except `\t` and `\n`, DEL and C1;
 * 4. remove hidden constructs: HTML comments, markdown images, `<img>` tags
 *    (counted in `removedHidden`);
 * 5. escape delimiter look-alikes (`<untrusted…`, `</y…`) by replacing
 *    `<` with U+2039 (`encodeUntrustedContent` additionally escapes every `<`
 *    when the content is enveloped);
 * 6. collapse runs of more than 2 blank lines to 2.
 * Idempotent.
 */
export function normalizeUntrusted(text: string): NormalizedText {
  const d = normalizeDetailed(text);
  return {
    text: d.text,
    removedInvisible: d.removedInvisible,
    removedHidden: d.removedHidden,
    escapedDelimiters: d.escapedDelimiters,
    changed: d.changed,
  };
}

/** Deep-normalize every string in a JSON-like value (object keys are left as is). */
export function deepNormalize<T>(value: T): T {
  if (typeof value === 'string') return normalizeUntrusted(value).text as T;
  if (Array.isArray(value)) return value.map((v) => deepNormalize(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepNormalize(v);
    return out as T;
  }
  return value;
}
