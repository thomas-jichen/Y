/**
 * Runs the whole narrated demo with --pace fast against in-process core + mcp
 * (in-memory PGlite, mock LLM/embedder, seeds loaded) and the built plugin bundles.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';
import { runDemo, mcpEndpoint } from './demo.js';
import { fit } from '@y/core';
import { loadSeeds, readSeeds, waitForEmbeddings } from './seeds.js';
import { startLocalStack, type LocalStack } from './servers.js';

let stack: LocalStack;
let seeded = 0;

beforeAll(async () => {
  stack = await startLocalStack({ testTemplate: true, verbose: !!process.env.Y_TEST_LOG });
  const r = await loadSeeds(stack.db, stack.deps);
  seeded = r.inserted + r.updated;
  // core's loader screens every seed; the ones the L0 screen flags are skipped, not loaded
  for (const s of r.skipped) expect(s.reason).toMatch(/^screen:/);
  await waitForEmbeddings(stack.db);
});

afterAll(async () => {
  await stack?.stop();
});

describe('demo cli args', () => {
  it('parses flags, skips a bare --, and rejects a bad pace', () => {
    const a = parseArgs(['--', '--api', 'http://x:8787', '--mcp=http://y:3000', '--pace', 'fast', '--demo-secret', 's3'], {});
    expect(a).toMatchObject({ api: 'http://x:8787', mcp: 'http://y:3000', pace: 'fast', demoSecret: 's3', expectSeeds: false });
    expect(() => parseArgs(['--api', 'a', '--mcp', 'b', '--pace', 'slow'], {})).toThrow(/pace/);
    expect(() => parseArgs([], {})).toThrow(/usage/);
    expect(mcpEndpoint('http://y:3000/')).toBe('http://y:3000/mcp');
    expect(mcpEndpoint('http://y:3000/mcp')).toBe('http://y:3000/mcp');
  });

  it('clips seed text to the column limits', () => {
    expect(fit('short', 90)).toBe('short');
    const c = fit('word '.repeat(40), 90);
    expect(c.length).toBeLessThanOrEqual(90);
    expect(c.endsWith('…')).toBe(true);
    for (const s of readSeeds()) expect(fit(s.title, 90).length).toBeLessThanOrEqual(90);
  });
});

describe('narrated demo (--pace fast, in-process servers)', () => {
  it('runs every step and verifies each outcome', async () => {
    expect(seeded).toBeGreaterThan(0);
    const lines: string[] = [];
    const res = await runDemo({
      api: stack.coreUrl,
      mcp: stack.mcpUrl,
      pace: 'fast',
      expectSeeds: true,
      isolateStranger: stack.isolateStranger,
      out: (l) => lines.push(l),
    });
    const transcript = lines.join('\n');
    expect(res.steps.map((s) => `${s.n}:${s.status}`), transcript).toEqual(['0:ok', '1:ok', '2:ok', '3:ok', '4:ok', '5:ok', '6:ok', '7:ok']);
    expect(res.ok).toBe(true);
    // every step narrates and points at the web app
    for (let n = 0; n <= 7; n++) expect(transcript).toContain(`[${n}]`);
    expect(transcript.match(/look: /g)?.length ?? 0).toBeGreaterThanOrEqual(8);
    expect(transcript).toMatch(/watch the feed/);
    // nothing from DMs or the planted token reaches the narration through a push path
    expect(transcript).not.toMatch(/ghp_[A-Za-z0-9]{36}/);
    // the injection is stored but not delivered
    const inj = await stack.db.query<{ state: string }>(`select state::text from public.messages where body like '%aws/credentials%'`);
    expect(inj.rows.map((r) => r.state)).toEqual([expect.stringMatching(/quarantined|blocked|rejected/)]);
  });

  it('fails (and skips dependents) when core is unreachable', async () => {
    const res = await runDemo({ api: 'http://127.0.0.1:9', mcp: 'http://127.0.0.1:9', pace: 'fast', out: () => undefined });
    expect(res.ok).toBe(false);
    expect(res.steps[0]?.status).toBe('failed');
    expect(res.steps.slice(1).every((s) => s.status === 'skipped')).toBe(true);
  });
});
