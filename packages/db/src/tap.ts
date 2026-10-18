/**
 * A small TAP (Test Anything Protocol) parser for pgTAP output.
 */

/** The `1..N` line. */
export interface TapPlan {
  start: number;
  end: number;
  /** Reason from `1..0 # SKIP reason`, else null. */
  skip: string | null;
}

/** A `# SKIP` or `# TODO` directive on a test line. */
export interface TapDirective {
  kind: 'skip' | 'todo';
  reason: string;
}

/** One `ok` / `not ok` line plus the `#` diagnostics that follow it. */
export interface TapAssertion {
  ok: boolean;
  /** The test number, or null when omitted. */
  id: number | null;
  description: string;
  directive: TapDirective | null;
  diagnostics: string[];
}

/** A parsed TAP stream. */
export interface TapReport {
  plan: TapPlan | null;
  assertions: TapAssertion[];
  /** Every `#` comment line, without the leading `# `. */
  comments: string[];
  /** Reason from `Bail out!`, else null. */
  bailOut: string | null;
  /** Passing tests (excluding skips). */
  passed: number;
  /** Failing tests, excluding `# TODO` ones. */
  failed: number;
  skipped: number;
  todo: number;
  /** Why the stream does not count as a pass. Empty when `ok`. */
  problems: string[];
  /** True when there is a plan, the counts match it, nothing failed and nobody bailed out. */
  ok: boolean;
  /** The recognized TAP lines, in order (indented subtest lines included). */
  lines: string[];
}

const PLAN_RE = /^1\.\.(\d+)\s*(?:#\s*(.*))?$/;
const TEST_RE = /^(not ok|ok)\b\s*(\d+)?\s*(?:-\s*)?(.*)$/;
const DIRECTIVE_RE = /\s*(?<!\\)#\s*(skip|todo)\S*\s*(.*)$/i;
const BAIL_RE = /^Bail out!\s*(.*)$/;

/** True when `line` looks like a TAP line (plan, test, comment, bail out, or indented subtest output). */
export function isTapLine(line: string): boolean {
  return (
    PLAN_RE.test(line) ||
    TEST_RE.test(line) ||
    line.startsWith('#') ||
    BAIL_RE.test(line) ||
    (/^\s+\S/.test(line) && isTapLine(line.trimStart())) ||
    /^TAP version \d+$/.test(line)
  );
}

/**
 * Parses TAP text (or lines; values may contain newlines). Lines that are not
 * TAP are ignored. Indented lines (pgTAP subtests from `runtests()`) are kept
 * in `lines` but not counted; their summary line at the top level is.
 */
export function parseTap(input: string | readonly string[]): TapReport {
  const raw = (typeof input === 'string' ? [input] : input).flatMap((chunk) => chunk.split('\n'));
  const report: TapReport = {
    plan: null,
    assertions: [],
    comments: [],
    bailOut: null,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    problems: [],
    ok: false,
    lines: [],
  };
  let last: TapAssertion | null = null;

  for (const rawLine of raw) {
    const line = rawLine.replace(/\r$/, '');
    if (!isTapLine(line)) continue;
    report.lines.push(line);
    if (/^\s/.test(line) || line.startsWith('TAP version')) continue;

    const plan = PLAN_RE.exec(line);
    if (plan) {
      const comment = plan[2]?.trim() ?? '';
      const skip = /^skip\S*\s*(.*)$/i.exec(comment);
      if (report.plan) report.problems.push(`more than one plan (${line})`);
      report.plan = { start: 1, end: Number(plan[1]), skip: skip ? (skip[1] ?? '') : null };
      continue;
    }

    const bail = BAIL_RE.exec(line);
    if (bail) {
      report.bailOut = bail[1] ?? '';
      continue;
    }

    if (line.startsWith('#')) {
      const text = line.replace(/^#\s?/, '');
      report.comments.push(text);
      last?.diagnostics.push(text);
      continue;
    }

    const test = TEST_RE.exec(line);
    if (test) {
      let description = test[3] ?? '';
      let directive: TapDirective | null = null;
      const match = DIRECTIVE_RE.exec(description);
      if (match) {
        directive = { kind: match[1]!.toLowerCase() as 'skip' | 'todo', reason: (match[2] ?? '').trim() };
        description = description.slice(0, match.index);
      }
      const assertion: TapAssertion = {
        ok: test[1] === 'ok',
        id: test[2] === undefined ? null : Number(test[2]),
        description: description.trim().replace(/\\#/g, '#'),
        directive,
        diagnostics: [],
      };
      report.assertions.push(assertion);
      last = assertion;
      if (directive?.kind === 'skip') report.skipped++;
      else if (directive?.kind === 'todo') report.todo++;
      if (assertion.ok && directive?.kind !== 'skip') report.passed++;
      if (!assertion.ok && directive?.kind !== 'todo') report.failed++;
    }
  }

  const count = report.assertions.length;
  if (report.bailOut !== null) report.problems.push(`bailed out${report.bailOut ? `: ${report.bailOut}` : ''}`);
  if (!report.plan) {
    report.problems.push(count === 0 ? 'no plan and no tests' : `no plan (ran ${count} test${count === 1 ? '' : 's'})`);
  } else if (report.plan.skip === null || count > 0) {
    const planned = report.plan.end - report.plan.start + 1;
    if (planned !== count) report.problems.push(`planned ${planned} test${planned === 1 ? '' : 's'} but ran ${count}`);
  }
  if (report.failed > 0) report.problems.push(`${report.failed} failed`);
  report.ok = report.problems.length === 0;
  return report;
}
