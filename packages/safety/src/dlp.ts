/**
 * Outbound DLP on every agent-authored body (I10).
 *
 * @module dlp
 */
import { findSecrets, ruleId } from './l0.js';

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

const CODE_LINE_RE =
  /^\s*(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]|export\s+(?:default|const|function|class|interface|type|async)\b|(?:const|let|var)\s+[\w{}[\],\s]+\s*=|(?:async\s+)?function\s*\w*\s*\(|class\s+\w+|def\s+\w+\s*\(|from\s+[\w.]+\s+import\s|#include\s*[<"]|package\s+[\w.]+;|public\s+(?:static\s+)?(?:class|void|int|final)|return\b[^\n]*;\s*$|(?:if|for|while|switch)\s*\(.*\)\s*\{?\s*$|\}\s*(?:else\b[^\n]*)?\{?\s*$|[^\n]*\brequire\(\s*['"]|@\w+\([^)]*\)\s*$)|[;{]\s*$|^\s*[})\]];?\s*$/;
const BRACEY_RE = /[{};]/g;

function isCodeLine(line: string): boolean {
  if (line.trim().length === 0) return false;
  if (CODE_LINE_RE.test(line)) return true;
  return (line.match(BRACEY_RE)?.length ?? 0) >= 3;
}

const PATH_LIKE_RE = /(?:^|[\s(`'"])((?:\.{0,2}\/)?(?:[\w.@-]+\/){2,}[\w.-]+\.[a-z0-9]{1,6})\b/gi;

/**
 * Outbound DLP on every agent-authored body (I10): secrets (`scanSecrets`),
 * code fences, code shape (≥ 3 consecutive lines that look like code:
 * import/require/def/class/function, braces and semicolons; single
 * import/require lines count too), path-like strings (counted as code), and
 * matches of the sender's own repo paths. `ok` is false on any secret, any
 * known repo path, and any code unless `allowShortCode` and the code is
 * ≤ 5 lines.
 */
export function dlpScan(body: string, opts?: DlpOptions): DlpResult {
  const text = typeof body === 'string' ? body : '';
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
  let runStart = -1;
  const flush = (endIdx: number) => {
    if (runStart < 0) return;
    const len = endIdx - runStart;
    const single = len === 1 && /^\s*(?:import\s|from\s+\S+\s+import|[^\n]*\brequire\(\s*['"])/.test(lines[runStart]?.text ?? '');
    if (len >= 3 || single) {
      codeLines += len;
      findings.push({ kind: 'code_shape', rule: 'dlp.code_shape', start: lines[runStart]?.start ?? 0, end: lineEnd(endIdx - 1) });
    }
    runStart = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    if (!inFence[i] && isCodeLine(lines[i]?.text ?? '')) {
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
