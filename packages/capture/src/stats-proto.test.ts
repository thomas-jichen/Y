/**
 * Red-team #60 (capture side): tool, MCP server and extension names such as
 * `toString`, `constructor` or `__proto__` are ordinary stat keys. Counting
 * them must never read or write `Object.prototype` members or globals.
 * Synthetic transcripts only.
 */
import { ActivityStats, totalToolCalls } from '@y/schema';
import { describe, expect, it } from 'vitest';
import { computeStats, parseClaudeRecords } from './index.js';

let n = 0;
function uses(names: string[], extra: Record<string, unknown>[] = []): ReturnType<typeof parseClaudeRecords>['records'] {
  return parseClaudeRecords([
    JSON.stringify({
      type: 'assistant',
      message: {
        id: `m${n++}`,
        role: 'assistant',
        content: [
          ...names.map((name) => ({ type: 'tool_use', id: `t${n++}`, name, input: {} })),
          ...extra.map((input) => ({ type: 'tool_use', id: `t${n++}`, name: 'Write', input })),
        ],
      },
    }),
  ]).records;
}

describe('#60 computeStats with Object.prototype member names', () => {
  it('counts tools named toString / valueOf / constructor / hasOwnProperty / __proto__ as numbers', () => {
    const s = computeStats(uses(['toString', 'toString', 'valueOf', 'constructor', 'hasOwnProperty', '__proto__', '__proto__', 'Bash']), []);
    expect(JSON.parse(JSON.stringify(s.toolCalls))).toEqual(
      JSON.parse('{"toString":2,"valueOf":1,"constructor":1,"hasOwnProperty":1,"__proto__":2,"Bash":1}'),
    );
    for (const v of Object.values(s.toolCalls)) expect(typeof v).toBe('number');
    expect(Object.getPrototypeOf(s.toolCalls)).toBe(Object.prototype);
    expect(totalToolCalls(s)).toBe(8);
    expect(ActivityStats.safeParse(s).success).toBe(true);
  });

  it('never writes to globals through MCP server and tool names', () => {
    const keysBefore = Object.keys;
    const s = computeStats(uses(['mcp__constructor__keys', 'mcp__constructor__keys', 'mcp__hasOwnProperty__toString', 'mcp__toString____proto__']), []);
    expect(Object.keys).toBe(keysBefore);
    expect(typeof Object.keys).toBe('function');
    expect(typeof Object.prototype.toString).toBe('function');
    expect(JSON.parse(JSON.stringify(s.mcp))).toEqual(
      JSON.parse('{"constructor":{"keys":2},"hasOwnProperty":{"toString":1},"toString":{"__proto__":1}}'),
    );
    expect(Object.getPrototypeOf(s.mcp)).toBe(Object.prototype);
    expect(ActivityStats.safeParse(s).success).toBe(true);
  });

  it('counts file extensions named after prototype members', () => {
    const s = computeStats(uses([], [{ file_path: 'a.constructor', content: 'x' }, { file_path: 'b.__proto__', content: 'y' }, { file_path: 'c.tostring', content: 'z' }]), []);
    expect(JSON.parse(JSON.stringify(s.filesChanged.byExt))).toEqual(JSON.parse('{"constructor":1,"__proto__":1,"tostring":1}'));
    expect(s.filesChanged.count).toBe(3);
  });
});
