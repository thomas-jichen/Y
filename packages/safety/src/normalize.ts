/**
 * Normalization of third-party text (PLAN §10 L0, step 0).
 *
 * @module normalize
 */
import { INVISIBLE_CHARS_SOURCE } from '@paceline/schema';

/** Result of {@link normalizeUntrusted}. */
export interface NormalizedText {
  text: string;
  /** Number of invisible / bidi-control / tag characters removed. */
  removedInvisible: number;
  /** Number of hidden constructs removed (HTML comments, markdown/HTML images). */
  removedHidden: number;
  /** Number of delimiter look-alikes escaped (`<untrusted…`, `</paceline…`). */
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
const MD_IMAGE_G = /!\[([^\]\n]*)\]\(([^)\n]*)\)/g;
const HTML_IMG_G = /<img\b[^>]*>/gi;
const DELIMITER_G = /<(\/?)(\s*)(untrusted|paceline)/gi;
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

  // 4. Hidden constructs: HTML comments, markdown images, <img> tags.
  text = text.replace(HTML_COMMENT_G, (_m, body: string) => {
    removedHidden += 1;
    if (body.trim()) hidden.push(body);
    return '';
  });
  text = text.replace(MD_IMAGE_G, (_m, alt: string, url: string) => {
    removedHidden += 1;
    hidden.push(`${alt} ${url}`.trim());
    return '';
  });
  text = text.replace(HTML_IMG_G, (m) => {
    removedHidden += 1;
    hidden.push(m);
    return '';
  });

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
 *    in `@paceline/schema`) and Unicode tag characters (U+E0000–E007F);
 * 3. CRLF/CR → LF; remove C0 controls except `\t` and `\n`, DEL and C1;
 * 4. remove hidden constructs: HTML comments, markdown images, `<img>` tags
 *    (counted in `removedHidden`);
 * 5. escape delimiter look-alikes (`<untrusted…`, `</paceline…`) by replacing
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
