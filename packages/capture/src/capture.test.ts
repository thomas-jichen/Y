import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityStats, Lap, SetupSnapshot } from '@paceline/schema';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applySegmentEvent,
  buildDigest,
  buildLaps,
  classifyCommand,
  computeRepoKey,
  computeStats,
  newSegmentState,
  normalizeErrorSignature,
  normalizeGitRemote,
  parseClaudeRecords,
  parseTestSummary,
  readTranscriptDelta,
  sanitizeStatKey,
  snapshotSetup,
  SEGMENT_IDLE_MS,
  type ClaudeRecord,
} from './index.js';

const FIX = join(import.meta.dirname, '..', 'test', 'fixtures');
const lines = (f: string) => readFileSync(join(FIX, f), 'utf8').split('\n').filter(Boolean);
const main = parseClaudeRecords(lines('session-main.jsonl'));
const sub = parseClaudeRecords(lines('subagent-a1.jsonl'));
const tmp = mkdtempSync(join(tmpdir(), 'paceline-capture-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('readTranscriptDelta', () => {
  it('returns only complete lines and resumes from the cursor', async () => {
    const p = join(tmp, 't.jsonl');
    writeFileSync(p, '{"a":1}\n{"b":2}\r\n{"c":');
    const d1 = await readTranscriptDelta(p, null);
    expect(d1.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(d1.reset).toBe(false);
    expect(d1.more).toBe(false);
    appendFileSync(p, '3}\n\n{"d":4}\n');
    const d2 = await readTranscriptDelta(p, d1.cursor);
    expect(d2.lines).toEqual(['{"c":3}', '{"d":4}']);
    const d3 = await readTranscriptDelta(p, d2.cursor);
    expect(d3.lines).toEqual([]);
    expect(d3.cursor.offset).toBe(d2.cursor.offset);
  });
  it('resets when the file shrank or the inode changed', async () => {
    const p = join(tmp, 'r.jsonl');
    writeFileSync(p, '{"a":1}\n{"b":2}\n');
    const d1 = await readTranscriptDelta(p, null);
    writeFileSync(p, '{"x":1}\n');
    const d2 = await readTranscriptDelta(p, d1.cursor);
    expect(d2.reset).toBe(true);
    expect(d2.lines).toEqual(['{"x":1}']);
    const d3 = await readTranscriptDelta(p, { ...d2.cursor, ino: (d2.cursor.ino ?? 0) + 1 });
    expect(d3.reset).toBe(true);
    expect(d3.lines).toEqual(['{"x":1}']);
  });
  it('honors maxBytes with more=true and never splits a line', async () => {
    const p = join(tmp, 'm.jsonl');
    writeFileSync(p, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const d1 = await readTranscriptDelta(p, null, { maxBytes: 10 });
    expect(d1.lines).toEqual(['{"a":1}']);
    expect(d1.more).toBe(true);
    const d2 = await readTranscriptDelta(p, d1.cursor, { maxBytes: 3 }); // shorter than one line: extends
    expect(d2.lines).toEqual(['{"b":2}']);
  });
  it('missing file → empty', async () => {
    expect(await readTranscriptDelta(join(tmp, 'nope.jsonl'), { offset: 5 })).toEqual({ lines: [], cursor: { offset: 5 }, reset: false, more: false });
  });
});

describe('parseClaudeRecords', () => {
  it('is tolerant: skips malformed lines and keeps unknown types as other', () => {
    expect(main.skipped).toBe(3);
    expect(main.records.some((r) => r.kind === 'other')).toBe(true);
    expect(main.records.some((r) => r.kind === 'summary')).toBe(true);
    expect(() => parseClaudeRecords(['', '[]', 'null', '{"type":5}', '{"type":"user","message":"x"}'])).not.toThrow();
  });
  it('classifies prompts, meta, interrupts, api errors and drops thinking text', () => {
    const prompts = main.records.filter((r) => r.isHumanPrompt);
    expect(prompts).toHaveLength(2);
    expect(main.records.filter((r) => r.isInterrupt)).toHaveLength(1);
    expect(main.records.filter((r) => r.isApiError)).toHaveLength(1);
    expect(JSON.stringify(main.records)).not.toContain('private reasoning');
    const edit = main.records.find((r) => r.patch);
    expect(edit?.patch).toEqual({ linesAdded: 1, linesRemoved: 1 });
  });
});

describe('computeStats', () => {
  const stats = computeStats(main.records, [sub.records]);
  it('validates against ActivityStats', () => {
    expect(ActivityStats.safeParse(stats).success).toBe(true);
  });
  it('dedupes usage by message.id (keeps the last line) and counts subagents separately', () => {
    expect(stats.tokens).toEqual({ input: 240, output: 440, cacheRead: 15400, cacheWrite: 250, subagents: 550, total: 16880 });
    // Naive summing would over-count.
    let naive = 0;
    for (const r of main.records) if (r.usage) naive += r.usage.inputTokens;
    expect(naive).toBeGreaterThan(stats.tokens.input);
  });
  it('counts tools, MCP, skills, subagents', () => {
    expect(stats.toolCalls).toEqual({ Bash: 6, Edit: 2, Write: 1, Skill: 1, Task: 1 });
    expect(stats.mcp).toEqual({ paceline: { search_network: 1 } });
    expect(stats.skillsInvoked).toEqual(['db-helper']);
    expect(stats.subagents).toEqual({ count: 1, types: ['Explore'] });
  });
  it('files changed: counts and extensions only, patch-exact when available', () => {
    expect(stats.filesChanged).toEqual({ count: 3, byExt: { ts: 1, md: 2 }, linesAdded: 5, linesRemoved: 1 });
    expect(JSON.stringify(stats)).not.toContain('/work/');
    expect(JSON.stringify(stats)).not.toContain('db.ts');
  });
  it('commands, tests, errors, signals', () => {
    expect(stats.commands).toEqual({ test: 2, build: 0, lint: 0, git: 2, install: 0, other: 2 });
    expect(stats.tests).toEqual({ runs: 2, last: { passed: 12, failed: 0, framework: 'vitest' }, greenAtEnd: true, confidence: 0.9 });
    expect(stats.errors).toEqual({ toolFailures: 2, apiErrors: 1, interrupts: 1 });
    expect(stats.turns).toBe(2);
    expect(stats.userCorrections).toBe(1);
    expect(stats.gitCommits).toBe(1);
    expect(stats.prUrlsCount).toBe(1);
    expect(stats.models).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(stats.harnessVersion).toBe('2.1.300');
  });
  it('active time excludes gaps ≥5 min and user think time; wall is first→last', () => {
    expect(stats.wallMs).toBe(610_000);
    expect(stats.activeMs).toBe(155_000);
  });
  it('estimates cost from pricing, or uses harness cost state', () => {
    expect(stats.costSource).toBe('estimate');
    expect(stats.costUsd).toBeCloseTo(0.008609, 6);
    const withCost = main.records.map((r, i) => (i === main.records.length - 1 ? { ...r, costUsd: 1.25 } : r));
    const s2 = computeStats(withCost, [], { previousCostUsd: 1 });
    expect(s2.costSource).toBe('harness');
    expect(s2.costUsd).toBeCloseTo(0.25, 6);
  });
  it('empty input', () => {
    expect(computeStats([], [], { harnessVersion: '1.0.0' }).harnessVersion).toBe('1.0.0');
  });
  it('red at end when the last test run fails', () => {
    const recs = parseClaudeRecords([
      JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pytest -q' } }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: '==== 1 failed, 9 passed in 0.52s ====' }] } }),
    ]).records;
    expect(computeStats(recs, []).tests).toEqual({ runs: 1, last: { passed: 9, failed: 1, framework: 'pytest' }, greenAtEnd: false, confidence: 0.9 });
  });
});

describe('classifyCommand', () => {
  const cases: [string, string][] = [
    ['pnpm test', 'test'], ['cd app && pnpm --filter @x/y test', 'test'], ['npx vitest run src', 'test'], ['npm run test:unit', 'test'],
    ['go test ./...', 'test'], ['cargo test', 'test'], ['python -m pytest -q', 'test'], ['FOO=1 jest', 'test'], ['yarn test', 'test'],
    ['tsc -p .', 'build'], ['pnpm run build', 'build'], ['next build', 'build'], ['cargo build --release', 'build'], ['make', 'build'],
    ['pnpm lint', 'lint'], ['npm run typecheck', 'lint'], ['eslint .', 'lint'], ['prettier --check .', 'lint'], ['ruff check', 'lint'],
    ['git status', 'git'], ['gh pr view', 'git'], ['sudo git push', 'git'],
    ['pnpm add zod', 'install'], ['npm i', 'install'], ['pip install -r req.txt', 'install'], ['go get x', 'install'], ['brew install jq', 'install'],
    ['ls -la', 'other'], ['quarry migrate', 'other'], ['prettier --write .', 'other'],
  ];
  for (const [cmd, cat] of cases) it(`${cmd} → ${cat}`, () => expect(classifyCommand(cmd)).toBe(cat));
});

describe('parseTestSummary', () => {
  it('parses each framework, last summary wins', () => {
    expect(parseTestSummary('Tests  2 failed | 40 passed | 1 skipped (43)')).toEqual({ passed: 40, failed: 2, framework: 'vitest' });
    expect(parseTestSummary('Tests:       1 failed, 41 passed, 42 total')).toEqual({ passed: 41, failed: 1, framework: 'jest' });
    expect(parseTestSummary('  12 passing (30ms)\n  2 failing')).toEqual({ passed: 12, failed: 2, framework: 'mocha' });
    expect(parseTestSummary('===== 3 passed, 1 error in 0.12s =====')).toEqual({ passed: 3, failed: 1, framework: 'pytest' });
    expect(parseTestSummary('--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\nFAIL\tgithub.com/x/y\t0.01s')).toEqual({ passed: 1, failed: 1, framework: 'go' });
    expect(parseTestSummary('test result: ok. 7 passed; 0 failed; 0 ignored')).toEqual({ passed: 7, failed: 0, framework: 'cargo' });
    expect(parseTestSummary('Tests  1 failed | 2 passed (3)\n...\nTests  3 passed (3)')).toEqual({ passed: 3, failed: 0, framework: 'vitest' });
    expect(parseTestSummary('hello')).toBeUndefined();
  });
});

describe('buildLaps', () => {
  it('one lap per Stop chunk', () => {
    const recs = main.records;
    const cut = recs.findIndex((r) => r.isHumanPrompt && r !== recs.find((x) => x.isHumanPrompt));
    const laps = buildLaps([recs.slice(0, cut), [], recs.slice(cut)], 4);
    expect(laps).toHaveLength(2);
    for (const l of laps) expect(Lap.safeParse(l).success).toBe(true);
    expect(laps[0]).toMatchObject({ index: 4, startedAt: '2026-10-17T10:00:00.000Z', turns: 1, errors: 2, toolCalls: 12 });
    expect(laps[1]).toMatchObject({ index: 5, turns: 1, errors: 1, toolCalls: 0, tokens: 2050 });
    expect(laps[0]!.tokens + laps[1]!.tokens).toBe(16880 - 550);
  });
});

describe('buildDigest', () => {
  const d = buildDigest(main.records, { projectDir: '/work/quarry-app' });
  it('keeps prompts, tool one-liners, error→fix windows, config diffs and FINAL', () => {
    expect(d.text).toContain('USER: The quarry migrate command keeps failing. Fix it and make the tests pass.');
    expect(d.text).toContain('TOOL Bash: quarry migrate\nERROR Bash: Error: connect ETIMEDOUT 10.0.0.5:5432 after 30000ms ⏎ at TCPConnectWrap');
    expect(d.text).toContain('TOOL Bash: QUARRY_DIRECT=1 quarry migrate\nOK Bash: Migrated 3 tables in 1.2s');
    expect(d.text).toContain('TOOL Edit: src/db.ts (+1/−1)');
    expect(d.text).toContain('TOOL Write: docs/db.md (+3/−0)');
    expect(d.text).toContain('CONFIG CLAUDE.md:\n@@\n+Run migrations with QUARRY_DIRECT=1.');
    expect(d.text).toContain('TOOL mcp:paceline/search_network');
    expect(d.text).toContain('ERROR Bash: FAIL src/db.test.ts > uses direct ⏎ Test Files 1 failed | 2 passed (3) ⏎ Tests 1 failed | 11 passed (12)\n');
    expect(d.text).toContain('OK Bash: Test Files 3 passed (3) ⏎ Tests 12 passed (12) ⏎ Duration 1.10s');
    expect(d.text).toMatch(/FINAL: Done: migrations use the direct connection/);
    expect(d.text).not.toContain('private reasoning');
    expect(d.text).not.toContain('/work/quarry-app');
    expect(d.errorWindows).toBe(2);
    expect(d.truncated).toBe(false);
  });
  it('caps tokens, dropping assistant text first and never error→fix pairs or FINAL', () => {
    const small = buildDigest(main.records, { projectDir: '/work/quarry-app', maxTokens: 250, lastAssistantMessage: 'All green.' });
    expect(small.truncated).toBe(true);
    expect(small.text).not.toContain('ASSISTANT:');
    expect(small.text).toContain('ERROR Bash: Error: connect ETIMEDOUT');
    expect(small.text).toContain('OK Bash: Migrated 3 tables');
    expect(small.text).toContain('TOOL Bash: QUARRY_DIRECT=1 quarry migrate');
    expect(small.text).toContain('FINAL: All green.');
  });
});

describe('normalizeErrorSignature', () => {
  it('normalizes the fixture error', () => {
    const sig = normalizeErrorSignature('\u001b[31mError: connect ETIMEDOUT 10.0.0.5:5432 after 30000ms\u001b[0m\n    at TCPConnectWrap.afterConnect (node:net:1607:16)');
    expect(sig).toBe('error: connect etimedout <ip>:<n> after <n>ms');
    expect(normalizeErrorSignature('Error: connect ETIMEDOUT 192.168.1.9:6543 after 10000ms')).toBe(sig);
  });
  it('strips paths, line:col, hex, uuids; keeps codes', () => {
    expect(normalizeErrorSignature("src/app/page.tsx:12:5 - error TS2345: Argument of type 'string' is not assignable")).toBe(
      "<path> - error ts2345: argument of type 'string' is not assignable",
    );
    expect(normalizeErrorSignature('Error: ENOENT: no such file or directory, open \'/Users/x/proj/.env\'')).toBe(
      "error: enoent: no such file or directory, open '<path>'",
    );
    expect(normalizeErrorSignature('panic: request 123e4567-e89b-12d3-a456-426614174000 failed at 0xdeadbeef')).toBe('panic: request <hex> failed at <hex>');
    expect(normalizeErrorSignature('GET https://api.example.com/v1/x?y=1 failed with 503')).toBe('get <url> failed with <n>');
    expect(normalizeErrorSignature('   \n\u001b[0m ')).toBe('');
  });
  it('is idempotent', () => {
    for (const s of ['Error: connect ETIMEDOUT 10.0.0.5:5432 after 30000ms', "TS2345 at /a/b/c.ts:1:2 'a very long quoted string that is long'", 'E404 Not Found - GET https://registry.npmjs.org/@x%2fy']) {
      const a = normalizeErrorSignature(s);
      expect(normalizeErrorSignature(a)).toBe(a);
    }
  });
});

describe('snapshotSetup', () => {
  it('collects allowlisted metadata only and validates', async () => {
    const home = join(tmp, 'home');
    const cfg = join(home, '.claude');
    const proj = join(tmp, 'proj');
    const plug = join(cfg, 'plugins', 'cache', 'paceline');
    for (const d of [join(cfg, 'skills', 'db-helper'), join(cfg, 'agents'), join(proj, '.claude', 'skills', 'Bad Name!'), join(plug, 'skills', 'scroll'), join(plug, 'hooks')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({
      model: 'claude-opus-5-5', effortLevel: 'high', enabledPlugins: { 'paceline@paceline-mkt': true, 'off@x': false },
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node secret-script.mjs --token abc' }] }] },
    }));
    writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' }, outputStyle: 'Explanatory' }));
    writeFileSync(join(proj, '.claude', 'settings.local.json'), '{not json');
    writeFileSync(join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'paceline@paceline-mkt': [{ version: '0.1.0', installPath: plug }] } }));
    writeFileSync(join(plug, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] } }));
    writeFileSync(join(plug, 'skills', 'scroll', 'SKILL.md'), '---\nname: scroll\ndescription: Scroll the feed\n---\nbody');
    writeFileSync(join(cfg, 'skills', 'db-helper', 'SKILL.md'), '---\nname: db-helper\ndescription: "Helps Ada with quarry DBs"\n---\nSECRET BODY');
    writeFileSync(join(proj, '.claude', 'skills', 'Bad Name!', 'SKILL.md'), 'no frontmatter');
    writeFileSync(join(cfg, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\n');
    writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: {
      remote: { type: 'http', url: 'https://mcp.example-vendor.com/v1/secret-path?key=1', headers: { Authorization: 'x' } },
      local: { command: 'node', args: ['server.js', '--key', 'zzz'], env: { TOKEN: 'zzz' } },
      lan: { type: 'sse', url: 'http://10.0.0.5:8080/sse' },
      corp: { type: 'http', url: 'https://mcp.corp.internal/x' },
    } }));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [proj]: { mcpServers: { mine: { type: 'stdio', command: 'x' } } } } }));
    writeFileSync(join(proj, 'CLAUDE.md'), '# Title\n## Rules for Ada\ntext\n```\n## not a heading\n```\n## Testing\n');
    const snap = await snapshotSetup({ projectDir: proj, homeDir: home, configDir: cfg, redactText: (t) => t.replace(/Ada/g, '<USER>') });
    const parsed = SetupSnapshot.safeParse(snap);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(snap.model).toBe('claude-opus-5-5');
    expect(snap.effort).toBe('high');
    expect(snap.permissionMode).toBe('acceptEdits');
    expect(snap.outputStyle).toBe('Explanatory');
    expect(snap.plugins).toEqual([{ name: 'paceline', marketplace: 'paceline-mkt', version: '0.1.0' }]);
    expect(snap.skills.map((s) => [s.name, s.scope, s.descriptionRedacted])).toEqual([
      ['Bad_Name_', 'project', ''],
      ['db-helper', 'user', 'Helps <USER> with quarry DBs'],
      ['scroll', 'plugin', 'Scroll the feed'],
    ]);
    expect(snap.mcpServers).toEqual([
      { name: 'corp', scope: 'project', transport: 'http' },
      { name: 'lan', scope: 'project', transport: 'sse' },
      { name: 'local', scope: 'project', transport: 'stdio' },
      { name: 'mine', scope: 'local', transport: 'stdio' },
      { name: 'remote', scope: 'project', transport: 'http', publicHost: 'mcp.example-vendor.com' },
    ]);
    expect(snap.hooks.map((h) => [h.event, h.matcher, h.scope])).toEqual([['PostToolUse', 'Bash', 'plugin'], ['Stop', '', 'user']]);
    expect(snap.claudeMd?.headings).toEqual(['Rules for <USER>', 'Testing']);
    expect(snap.subagents).toEqual(['reviewer']);
    const json = JSON.stringify(snap);
    for (const leak of ['secret-script', 'zzz', 'secret-path', 'SECRET BODY', 'server.js', '10.0.0.5', 'Authorization']) expect(json).not.toContain(leak);
  });
  it('empty setup still validates', async () => {
    const snap = await snapshotSetup({ projectDir: join(tmp, 'none'), homeDir: join(tmp, 'none'), redactText: (t) => t, configDir: join(tmp, 'none', '.claude') });
    expect(SetupSnapshot.safeParse(snap).success).toBe(true);
    expect(snap.claudeMd).toBeUndefined();
  });
});

describe('segments and repo keys', () => {
  it('closes on idle, clear, session_end', () => {
    const s0 = newSegmentState('s1', 'claude_code', 0);
    const t1 = applySegmentEvent(s0, { kind: 'stop', at: 1000 });
    expect(t1).toMatchObject({ close: null, opened: false });
    expect(t1.state.lastEventAt).toBe(1000);
    const t2 = applySegmentEvent(t1.state, { kind: 'stop', at: 1000 + SEGMENT_IDLE_MS });
    expect(t2).toMatchObject({ close: 'idle_timeout', opened: true });
    expect(t2.state.segmentIndex).toBe(1);
    expect(applySegmentEvent(t2.state, { kind: 'clear', at: t2.state.lastEventAt + 1 })).toMatchObject({ close: 'clear', opened: true });
    const end = applySegmentEvent(t2.state, { kind: 'session_end', at: t2.state.lastEventAt + 1 });
    expect(end).toMatchObject({ close: 'session_end', opened: false });
    expect(end.state.closed).toBe(true);
    expect(s0.lastEventAt).toBe(0); // pure
  });
  it('normalizes remotes and computes repo keys', () => {
    for (const r of ['git@github.com:Acme/API.git', 'https://github.com/acme/api', 'ssh://git@github.com/acme/api.git', 'https://user:tok@github.com/acme/api/']) {
      expect(normalizeGitRemote(r)).toBe('github.com/acme/api');
    }
    expect(normalizeGitRemote('not a remote')).toBeUndefined();
    const k = computeRepoKey('git@github.com:Acme/API.git', 'c2FsdA');
    expect(k).toMatch(/^[a-f0-9]{64}$/);
    expect(computeRepoKey('https://github.com/acme/api', 'c2FsdA')).toBe(k);
  });
  it('sanitizeStatKey', () => {
    expect(sanitizeStatKey('mcp tool!')).toBe('mcp_tool_');
    expect(sanitizeStatKey('')).toBe('_');
  });
});

// Keep the type import used.
export type _R = ClaudeRecord;
