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
/** CJK scripts: prose in these uses fullwidth punctuation that NFKC folds to `;`, `{`, `(`. */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;

/**
 * Internal (exported for tests): whether one line looks like code. `lenient` (used only on the NFKC view)
 * ignores the punctuation-only signals on CJK lines, whose fullwidth `；`/`｛`
 * fold to ASCII.
 */
export function isCodeLine(line: string, lenient = false): boolean {
  if (line.trim().length === 0) return false;
  if (STRONG_CODE_LINE_RE.test(line)) return true;
  if (lenient && CJK_RE.test(line)) return false;
  if (WEAK_CODE_LINE_RE.test(line)) return true;
  return (line.match(BRACEY_RE)?.length ?? 0) >= 3;
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
  const counted = new Array<boolean>(lines.length).fill(false);
  let runStart = -1;
  const flush = (endIdx: number) => {
    if (runStart < 0) return;
    const len = endIdx - runStart;
    const single = len === 1 && SINGLE_CODE_LINE_RE.test(lines[runStart]?.text ?? '');
    if (len >= 3 || single) {
      codeLines += len;
      for (let k = runStart; k < endIdx; k++) counted[k] = true;
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

  // Blank lines don't break a run: code split into 1–2 line chunks by blank
  // lines (`a;\n\nb;\n\nc;`) is still ≥ 3 code lines. Runs the pass above
  // already counted in full are unchanged; this only adds lines it skipped.
  {
    let first = -1;
    let last = -1;
    let total = 0;
    let extra = 0;
    let pieces = 0;
    const end = () => {
      if (first >= 0 && pieces > 1 && total >= 3 && extra > 0) {
        codeLines += extra;
        findings.push({ kind: 'code_shape', rule: 'dlp.code_shape', start: lines[first]?.start ?? 0, end: lineEnd(last) });
      }
      first = -1;
      last = -1;
      total = 0;
      extra = 0;
      pieces = 0;
    };
    for (let i = 0; i < lines.length; i++) {
      if (isCode[i]) {
        if (first < 0) first = i;
        if (i === 0 || !isCode[i - 1]) pieces++;
        last = i;
        total++;
        if (!counted[i]) extra++;
      } else if (inFence[i] || (lines[i]?.text.trim().length ?? 0) > 0) end();
    }
    end();
  }

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
 * code fences, code shape (≥ 3 lines that look like code, consecutive or
 * separated only by blank lines: import/require/def/class/function, braces
 * and semicolons; single import/require lines count too), path-like strings
 * (counted as code), and matches of the sender's own repo paths. `ok` is
 * false on any secret, any known repo path, and any code unless
 * `allowShortCode` and the code is ≤ 5 lines.
 *
 * Recipients and storage see the **normalized** text (`normalizeUntrusted`:
 * NFKC, lone CR → LF, invisible characters stripped), so when that differs
 * from the raw body it is scanned too and the stricter result wins:
 * fullwidth code (`ｉｍｐｏｒｔ`) or CR-separated lines can't slip past.
 * When only the normalized view fails, the findings' offsets refer to the
 * normalized text.
 */
export function dlpScan(body: string, opts?: DlpOptions): DlpResult {
  const text = typeof body === 'string' ? body : '';
  const raw = scanText(text, opts, false);
  if (!raw.ok) return raw;
  const normalized = normalizeUntrusted(text).text;
  if (normalized === text) return raw;
  const view = scanText(normalized, opts, true);
  return view.ok ? raw : view;
}
