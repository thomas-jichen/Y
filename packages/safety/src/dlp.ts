/**
 * Outbound DLP on every agent-authored body (I10).
 *
 * @module dlp
 */
import { findSecrets, ruleId } from './l0.js';
import { normalizeUntrusted } from './normalize.js';

/** One DLP hit (never includes the matched text). */
export interface DlpFinding {
  kind: 'secret' | 'code_fence' | 'code_shape' | 'repo_path';
  rule: string;
  start: number;
  end: number;
}

/** Options for {@link dlpScan}. */
export interface DlpOptions {
  /** Repo-relative paths of the sender's repo (from the client); matches are `repo_path` hits. */
  repoPaths?: readonly string[];
  /** Same-team sends may allow short code (≤ 5 lines); cross-owner sends never do. */
  allowShortCode?: boolean;
}

/** Result of {@link dlpScan}. */
export interface DlpResult {
  /** False → the send is `held_for_sender` (I10). */
  ok: boolean;
  findings: DlpFinding[];
  /** Number of secret hits. */
  secrets: number;
  /** True when the body contains code (fences, code-shaped lines or path-like strings). */
  codeShape: boolean;
  /** Lines counted as code (fence contents + code-shaped lines + path-like strings). */
  codeLines: number;
}

/** Max code lines a same-team body may carry with `allowShortCode`. */
export const DLP_SHORT_CODE_MAX_LINES = 5;

/*
 * Code-shaped line rules, for single lines (no `\n`). The patterns accept
 * exactly the lines the original single regex accepted, rewritten so that no
 * two adjacent quantifiers can match the same whitespace (that regex
 * backtracked cubically on `const` or `import` followed by a long run of
 * spaces). For example `(?:const|let|var)\s+[\w{}[\],\s]+\s*=` became
 * `(?:const|let|var)\s[\w{}[\],\s]+=`, and `\s*\{?\s*$` became `\s*(?:\{\s*)?$`.
 */
/** Statement-shaped lines (imports, declarations, control flow …). */
const STRONG_CODE_LINE_RE =
  /^(?:\s*(?:import(?:\s[\w*{}\s,]+\sfrom\s+|\s+)['"]|export\s+(?:default|const|function|class|interface|type|async)\b|(?:const|let|var)\s[\w{}[\],\s]+=|(?:async\s+)?function(?:\s*\w+)?\s*\(|class\s+\w+|def\s+\w+\s*\(|from\s+[\w.]+\s+import\s|#include\s*[<"]|package\s+[\w.]+;|public\s+(?:static\s+)?(?:class|void|int|final)|return\b[^\n]*;\s*$|(?:if|for|while|switch)\s*\(.*\)\s*(?:\{\s*)?$|\}\s*(?:else\b[^\n]*\s*$|(?:\{\s*)?$)|@\w+\([^)]*\)\s*$)|[^\n]*\brequire\(\s*['"])/;
/** Punctuation-only signals (a trailing `;`/`{`, a lone closing bracket). */
const WEAK_CODE_LINE_RE = /[;{]\s*$|^\s*[})\]];?\s*$/;
const BRACEY_RE = /[{};]/g;
/** CJK scripts and punctuation: prose in these uses fullwidth punctuation that NFKC folds to `;`, `{`, `(`. */
const CJK_RE = /[\u3001-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;
const TRAILING_PUNCT_RE = /[;{]\s*$/;
/** Skipped when looking for the text a punctuation mark follows (closing brackets, quotes, corner brackets). */
const CLOSER_RE = /[\s)\]}"'\u300D\u300F]/;

/** Whether the punctuation at `idx` follows CJK text (skipping spaces and closing brackets/quotes). */
function followsCjk(line: string, idx: number): boolean {
  let j = idx - 1;
  while (j >= 0 && CLOSER_RE.test(line[j] ?? '')) j--;
  return j >= 0 && CJK_RE.test(line[j] ?? '');
}

/**
 * Internal (exported for tests): whether one line looks like code. `lenient`
 * (used only on the NFKC view) ignores the punctuation-only signals (`;`/`{`
 * at the end, `{};` counts) where the punctuation follows CJK text: there
 * they are fullwidth `；`/`｛` folded to ASCII, not code. Punctuation after
 * Latin text (`a = f(x)；`) still counts.
 */
export function isCodeLine(line: string, lenient = false): boolean {
  if (line.trim().length === 0) return false;
  if (STRONG_CODE_LINE_RE.test(line)) return true;
  if (!lenient || !CJK_RE.test(line)) {
    if (WEAK_CODE_LINE_RE.test(line)) return true;
    return (line.match(BRACEY_RE)?.length ?? 0) >= 3;
  }
  const trailing = TRAILING_PUNCT_RE.exec(line);
  if (trailing && !followsCjk(line, trailing.index)) return true;
  if (/^\s*[})\]];?\s*$/.test(line)) return true;
  let bracey = 0;
  for (const m of line.matchAll(BRACEY_RE)) if (!followsCjk(line, m.index ?? 0)) bracey++;
  return bracey >= 3;
}

/**
 * Dropped from the normalized view before scanning (scanning only, never
 * from the delivered text): variation selectors, and combining marks after
 * an ASCII character. `normalizeUntrusted` keeps both (emoji, accents), but
 * they would otherwise hide a `;`, a ` ``` ` or a keyword from the line rules.
 */
const SCAN_DROP_G = /([\x00-\x7F])\p{M}+|[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

/**
 * Drop {@link SCAN_DROP_G} in one linear pass: a whole run of marks after an
 * ASCII character (variation selectors are marks too), and any other
 * variation selector. Same result as the old lookbehind form
 * `(?<=[\x00-\x7F]\p{M}*)\p{M}`, which rescanned the run for every mark.
 */
export function dropScanMarks(text: string): string {
  return text.replace(SCAN_DROP_G, (_m, ascii: string | undefined) => ascii ?? '');
}

const SINGLE_CODE_LINE_RE = /^\s*(?:import\s|from\s+\S+\s+import|[^\n]*\brequire\(\s*['"])/;

const PATH_LIKE_RE = /(?:^|[\s(`'"])((?:\.{0,2}\/)?(?:[\w.@-]+\/){2,}[\w.-]+\.[a-z0-9]{1,6})\b/gi;

/** One DLP pass over `text` (raw, or the normalized view with `lenient`). */
function scanText(text: string, opts: DlpOptions | undefined, lenient: boolean): DlpResult {
  const findings: DlpFinding[] = [];

  const secrets = findSecrets(text);
  for (const s of secrets) findings.push({ kind: 'secret', rule: ruleId('secret', s.ruleId), start: s.start, end: s.end });

  // Line table with offsets.
  const lines: { text: string; start: number }[] = [];
  {
    let pos = 0;
    for (const l of text.split('\n')) {
      lines.push({ text: l, start: pos });
      pos += l.length + 1;
    }
  }
  const lineEnd = (i: number) => (lines[i]?.start ?? 0) + (lines[i]?.text.length ?? 0);

  let codeLines = 0;
  const inFence = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:```|~~~)/.test(lines[i]?.text ?? '')) continue;
    let j = i + 1;
    while (j < lines.length && !/^\s*(?:```|~~~)/.test(lines[j]?.text ?? '')) j++;
    for (let k = i; k <= Math.min(j, lines.length - 1); k++) inFence[k] = true;
    const inner = lines.slice(i + 1, j).filter((l) => l.text.trim().length > 0).length;
    codeLines += Math.max(1, inner);
    findings.push({ kind: 'code_fence', rule: 'dlp.code_fence', start: lines[i]?.start ?? 0, end: lineEnd(Math.min(j, lines.length - 1)) });
    i = j;
  }

  // Code-shaped runs outside fences.
  const isCode = lines.map((l, i) => !inFence[i] && isCodeLine(l.text, lenient));
  let runStart = -1;
  const flush = (endIdx: number) => {
    if (runStart < 0) return;
    const len = endIdx - runStart;
    const single = len === 1 && SINGLE_CODE_LINE_RE.test(lines[runStart]?.text ?? '');
    if (len >= 3 || single) {
      codeLines += len;
      findings.push({ kind: 'code_shape', rule: 'dlp.code_shape', start: lines[runStart]?.start ?? 0, end: lineEnd(endIdx - 1) });
    }
    runStart = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    if (isCode[i]) {
      if (runStart < 0) runStart = i;
    } else flush(i);
  }
  flush(lines.length);

  // Known repo paths (exact matches) and path-like strings.
  let knownPaths = 0;
  for (const p of opts?.repoPaths ?? []) {
    if (typeof p !== 'string' || p.length < 4) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(p, from);
      if (at < 0) break;
      knownPaths++;
      findings.push({ kind: 'repo_path', rule: 'dlp.repo_path', start: at, end: at + p.length });
      from = at + p.length;
    }
  }
  PATH_LIKE_RE.lastIndex = 0;
  for (const m of text.matchAll(PATH_LIKE_RE)) {
    const path = m[1] ?? '';
    if (/^(?:https?:)?\/\//.test(path) || /:\/\/$/.test(text.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0))) continue;
    const start = (m.index ?? 0) + m[0].indexOf(path);
    if (findings.some((f) => f.kind === 'repo_path' && f.start <= start && f.end >= start + path.length)) continue;
    codeLines += 1;
    findings.push({ kind: 'repo_path', rule: 'dlp.path_like', start, end: start + path.length });
  }

  findings.sort((a, b) => a.start - b.start);
  const codeShape = codeLines > 0;
  const codeOk = !codeShape || (opts?.allowShortCode === true && codeLines <= DLP_SHORT_CODE_MAX_LINES);
  return {
    ok: secrets.length === 0 && knownPaths === 0 && codeOk,
    findings,
    secrets: secrets.length,
    codeShape,
    codeLines,
  };
}

/**
 * Outbound DLP on every agent-authored body (I10): secrets (`scanSecrets`),
 * code fences, code shape (≥ 3 consecutive lines that look like code:
 * import/require/def/class/function, braces and semicolons; single
 * import/require lines count too), path-like strings
 * (counted as code), and matches of the sender's own repo paths. `ok` is
 * false on any secret, any known repo path, and any code unless
 * `allowShortCode` and the code is ≤ 5 lines.
 *
 * Recipients and storage see the **normalized** text (`normalizeUntrusted`:
 * NFKC, lone CR → LF, invisible characters stripped), so when that differs
 * from the raw body it is scanned too and the stricter result wins:
 * fullwidth code (`ｉｍｐｏｒｔ`) or CR-separated lines can't slip past.
 * That view also drops variation selectors and combining marks after ASCII
 * (`a = f(x);` + U+FE0F). When only the normalized view fails, the
 * findings' offsets refer to that view.
 */
export function dlpScan(body: string, opts?: DlpOptions): DlpResult {
  const text = typeof body === 'string' ? body : '';
  const raw = scanText(text, opts, false);
  if (!raw.ok) return raw;
  const normalized = dropScanMarks(normalizeUntrusted(text).text);
  if (normalized === text) return raw;
  const view = scanText(normalized, opts, true);
  return view.ok ? raw : view;
}
