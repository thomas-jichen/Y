import { describe, expect, it } from 'vitest';
import { isTapLine, parseTap } from './tap.js';

describe('parseTap', () => {
  it('parses a passing pgTAP run', () => {
    const report = parseTap(['1..3', 'ok 1 - users exist', 'ok 2 - rls is on', 'ok 3']);
    expect(report).toMatchObject({ ok: true, passed: 3, failed: 0, problems: [], plan: { start: 1, end: 3, skip: null } });
    expect(report.assertions.map((a) => [a.id, a.description])).toEqual([
      [1, 'users exist'],
      [2, 'rls is on'],
      [3, ''],
    ]);
  });

  it('attaches diagnostics to the failing test and fails the report', () => {
    const report = parseTap(
      '1..2\nok 1 - fine\nnot ok 2 - nope\n# Failed test 2: "nope"\n#         have: 1\n#         want: 2\n# Looks like you failed 1 test of 2',
    );
    expect(report.ok).toBe(false);
    expect(report.failed).toBe(1);
    expect(report.problems).toEqual(['1 failed']);
    expect(report.assertions[1]!.diagnostics).toEqual([
      'Failed test 2: "nope"',
      '        have: 1',
      '        want: 2',
      'Looks like you failed 1 test of 2',
    ]);
    expect(report.comments).toHaveLength(4);
  });

  it('accepts multi-line values (pgTAP returns failure diagnostics in the same row)', () => {
    const report = parseTap(['1..1', 'not ok 1 - x\n# Failed test 1: "x"']);
    expect(report.assertions[0]!.diagnostics).toEqual(['Failed test 1: "x"']);
  });

  it('flags plan mismatches, missing plans and bail outs', () => {
    expect(parseTap(['1..3', 'ok 1', 'ok 2']).problems).toEqual(['planned 3 tests but ran 2']);
    expect(parseTap(['ok 1']).problems).toEqual(['no plan (ran 1 test)']);
    expect(parseTap([]).problems).toEqual(['no plan and no tests']);
    expect(parseTap(['1..2', 'ok 1', 'Bail out! database gone']).problems).toEqual([
      'bailed out: database gone',
      'planned 2 tests but ran 1',
    ]);
    expect(parseTap(['1..1', 'ok 1', '1..1']).problems).toContain('more than one plan (1..1)');
  });

  it('accepts a trailing plan (no_plan + finish())', () => {
    expect(parseTap(['ok 1', 'ok 2', '1..2']).ok).toBe(true);
  });

  it('handles SKIP and TODO directives', () => {
    const report = parseTap([
      '1..4',
      'ok 1 # SKIP no vectors here',
      'not ok 2 - flaky thing # TODO fix later',
      'ok 3 - escaped \\# hash',
      'ok 4 - real # skip',
    ]);
    expect(report).toMatchObject({ ok: true, passed: 1, skipped: 2, todo: 1, failed: 0 });
    expect(report.assertions[0]!.directive).toEqual({ kind: 'skip', reason: 'no vectors here' });
    expect(report.assertions[1]).toMatchObject({ description: 'flaky thing', directive: { kind: 'todo', reason: 'fix later' } });
    expect(report.assertions[2]!.description).toBe('escaped # hash');
  });

  it('accepts a skip-all plan', () => {
    const report = parseTap(['1..0 # Skipped: no pgvector']);
    expect(report.ok).toBe(true);
    expect(report.plan).toEqual({ start: 1, end: 0, skip: 'no pgvector' });
  });

  it('keeps indented subtest lines but counts only top-level tests', () => {
    const report = parseTap(['    # Subtest: test_rls', '    ok 1 - inner', '    1..1', 'ok 1 - test_rls', '1..1']);
    expect(report.ok).toBe(true);
    expect(report.assertions).toHaveLength(1);
    expect(report.lines).toHaveLength(5);
  });

  it('ignores non-TAP lines', () => {
    const report = parseTap(['{"sub":"x"}', 'okay then', '1..1', 'ok 1', 'NOTICE: hi']);
    expect(report.ok).toBe(true);
    expect(report.lines).toEqual(['1..1', 'ok 1']);
  });

  it('recognizes TAP lines', () => {
    for (const line of ['1..3', 'ok 1', 'not ok 2 - x', '# note', 'Bail out!', '    ok 1', 'TAP version 13']) {
      expect(isTapLine(line), line).toBe(true);
    }
    for (const line of ['', 'okay', 'select 1', '{}', '   ']) expect(isTapLine(line), line).toBe(false);
  });
});
