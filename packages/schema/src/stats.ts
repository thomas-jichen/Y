/**
 * `ActivityStats` v1 and `Lap`, exactly per docs/UI.md §4, plus the optional
 * extra signals from PLAN §7 (`gitCommits`, `prUrlsCount`, `userCorrections`).
 *
 * Stats are deterministic and computed by hooks only (`source=captured`);
 * the server recomputes cost. They never contain paths, prompts or output.
 *
 * @module stats
 */
import { z } from 'zod';
import { Count, IsoTimestamp, ModelId, Probability, StatKey, Usd, VersionString } from './common.js';

/** Version of the stats object stored in `activities.stats`. */
export const STATS_VERSION = 1 as const;

const MAX_MAP_KEYS = 256;

/** `{ key: count }` map with bounded keys. */
export const CountMap = z
  .record(StatKey, Count)
  .refine((m) => Object.keys(m).length <= MAX_MAP_KEYS, { error: `at most ${MAX_MAP_KEYS} keys` });
export type CountMap = z.infer<typeof CountMap>;

/**
 * Token usage. `input/output/cacheRead/cacheWrite` are the main thread after
 * de-duping assistant records by `message.id` (keep the last usage per id);
 * `subagents` is the total of all subagent transcripts (counted separately,
 * same dedupe). `total = input + output + cacheRead + cacheWrite + subagents`.
 */
export const TokenStats = z.object({
  input: Count,
  output: Count,
  cacheRead: Count,
  cacheWrite: Count,
  subagents: Count,
  total: Count,
});
export type TokenStats = z.infer<typeof TokenStats>;

/** Files changed, by count and extension only. Never paths. */
export const FilesChangedStats = z.object({
  count: Count,
  byExt: CountMap,
  linesAdded: Count,
  linesRemoved: Count,
});
export type FilesChangedStats = z.infer<typeof FilesChangedStats>;

/** Bash commands by category (classified by `@y/capture`). */
export const CommandStats = z.object({
  test: Count,
  build: Count,
  lint: Count,
  git: Count,
  install: Count,
  other: Count,
});
export type CommandStats = z.infer<typeof CommandStats>;

/** Test runs. `confidence` = how sure capture is about `greenAtEnd` (0..1). */
export const TestStats = z.object({
  runs: Count,
  last: z
    .object({
      passed: Count,
      failed: Count,
      framework: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/),
    })
    .optional(),
  greenAtEnd: z.boolean(),
  confidence: Probability,
});
export type TestStats = z.infer<typeof TestStats>;

/** Error counters. */
export const ErrorStats = z.object({
  toolFailures: Count,
  apiErrors: Count,
  interrupts: Count,
});
export type ErrorStats = z.infer<typeof ErrorStats>;

/** Where `costUsd` came from: the harness's own cost state, or our pricing table. */
export const CostSource = z.enum(['harness', 'estimate']);
export type CostSource = z.infer<typeof CostSource>;

/**
 * ActivityStats v1.
 * - `toolCalls`: built-in tool name → calls (MCP tools are counted only in `mcp`).
 * - `mcp`: server → tool → calls.
 * - `activeMs`: time the agent was working (sum of turn durations);
 *   `wallMs`: first to last event of the segment.
 */
export const ActivityStats = z.object({
  tokens: TokenStats,
  costUsd: Usd,
  costSource: CostSource,
  activeMs: Count,
  wallMs: Count,
  turns: Count,
  toolCalls: CountMap,
  mcp: z
    .record(StatKey, CountMap)
    .refine((m) => Object.keys(m).length <= 64, { error: 'at most 64 MCP servers' }),
  skillsInvoked: z.array(StatKey).max(100),
  subagents: z.object({
    count: Count,
    types: z.array(StatKey).max(50),
  }),
  filesChanged: FilesChangedStats,
  commands: CommandStats,
  tests: TestStats,
  errors: ErrorStats,
  models: z.array(ModelId).max(16),
  harnessVersion: VersionString,
  /** PLAN §7 extra signals (not in UI.md §4, so optional for mock compatibility); capture always sets them. */
  gitCommits: Count.optional(),
  prUrlsCount: Count.optional(),
  userCorrections: Count.optional(),
});
export type ActivityStats = z.infer<typeof ActivityStats>;

/** A lap = one Stop chunk of the segment. */
export const Lap = z.object({
  index: Count,
  startedAt: IsoTimestamp,
  turns: Count,
  tokens: Count,
  errors: Count,
  toolCalls: Count,
});
export type Lap = z.infer<typeof Lap>;

/** All-zero stats (`costSource: 'estimate'`, `harnessVersion: '0'`). */
export function emptyStats(harnessVersion = '0'): ActivityStats {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, subagents: 0, total: 0 },
    costUsd: 0,
    costSource: 'estimate',
    activeMs: 0,
    wallMs: 0,
    turns: 0,
    toolCalls: {},
    mcp: {},
    skillsInvoked: [],
    subagents: { count: 0, types: [] },
    filesChanged: { count: 0, byExt: {}, linesAdded: 0, linesRemoved: 0 },
    commands: { test: 0, build: 0, lint: 0, git: 0, install: 0, other: 0 },
    tests: { runs: 0, greenAtEnd: false, confidence: 0 },
    errors: { toolFailures: 0, apiErrors: 0, interrupts: 0 },
    models: [],
    harnessVersion,
    gitCommits: 0,
    prUrlsCount: 0,
    userCorrections: 0,
  };
}

/**
 * Own-property read of a counter map. Keys are tool, server and extension
 * names, so `toString`, `constructor` or `__proto__` are valid keys and must
 * never resolve to `Object.prototype` members.
 */
function ownGet<T>(m: Record<string, T>, k: string): T | undefined {
  return Object.hasOwn(m, k) ? m[k] : undefined;
}

/** Own-property write (an assignment to `__proto__` would set the prototype instead). */
function ownSet<T>(m: Record<string, T>, k: string, v: T): void {
  Object.defineProperty(m, k, { value: v, writable: true, enumerable: true, configurable: true });
}

function addCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(a)) ownSet(out, k, v);
  for (const [k, v] of Object.entries(b)) ownSet(out, k, (ownGet(out, k) ?? 0) + v);
  return out;
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Fold a stats delta into accumulated stats. This defines the semantics of
 * `IngestChunk.statsDelta`, and both the client and core use it:
 * - counters and maps are **added** (including `wallMs`, `filesChanged.count`;
 *   `tokens.total` is recomputed from its parts; a missing optional counter
 *   counts as 0 and the result always carries it);
 * - sets are **unioned** in first-seen order (`models`, `skillsInvoked`,
 *   `subagents.types`);
 * - last-value fields take the delta's value: `tests.last` (when present),
 *   `tests.greenAtEnd`, `tests.confidence`, `harnessVersion`;
 * - `costSource` is `harness` only if both sides are `harness`; a side with
 *   zero tokens doesn't count;
 * - `tests.greenAtEnd`/`confidence` keep the accumulated value when the delta
 *   saw no test run.
 *
 * Pure; never mutates its inputs.
 */
export function mergeStats(acc: ActivityStats, delta: ActivityStats): ActivityStats {
  const tokens = {
    input: acc.tokens.input + delta.tokens.input,
    output: acc.tokens.output + delta.tokens.output,
    cacheRead: acc.tokens.cacheRead + delta.tokens.cacheRead,
    cacheWrite: acc.tokens.cacheWrite + delta.tokens.cacheWrite,
    subagents: acc.tokens.subagents + delta.tokens.subagents,
    total: 0,
  };
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.subagents;

  const mcp: Record<string, Record<string, number>> = {};
  for (const [server, tools] of Object.entries(acc.mcp)) ownSet(mcp, server, tools);
  for (const [server, tools] of Object.entries(delta.mcp)) {
    ownSet(mcp, server, addCounts(ownGet(mcp, server) ?? {}, tools));
  }

  let costSource: CostSource;
  if (acc.tokens.total === 0) costSource = delta.costSource;
  else if (delta.tokens.total === 0) costSource = acc.costSource;
  else costSource = acc.costSource === 'harness' && delta.costSource === 'harness' ? 'harness' : 'estimate';

  const tests: TestStats = {
    runs: acc.tests.runs + delta.tests.runs,
    greenAtEnd: delta.tests.runs > 0 || delta.tests.last ? delta.tests.greenAtEnd : acc.tests.greenAtEnd,
    confidence: delta.tests.runs > 0 || delta.tests.last ? delta.tests.confidence : acc.tests.confidence,
  };
  const last = delta.tests.last ?? acc.tests.last;
  if (last) tests.last = last;

  return {
    tokens,
    costUsd: acc.costUsd + delta.costUsd,
    costSource,
    activeMs: acc.activeMs + delta.activeMs,
    wallMs: acc.wallMs + delta.wallMs,
    turns: acc.turns + delta.turns,
    toolCalls: addCounts(acc.toolCalls, delta.toolCalls),
    mcp,
    skillsInvoked: union(acc.skillsInvoked, delta.skillsInvoked),
    subagents: {
      count: acc.subagents.count + delta.subagents.count,
      types: union(acc.subagents.types, delta.subagents.types),
    },
    filesChanged: {
      count: acc.filesChanged.count + delta.filesChanged.count,
      byExt: addCounts(acc.filesChanged.byExt, delta.filesChanged.byExt),
      linesAdded: acc.filesChanged.linesAdded + delta.filesChanged.linesAdded,
      linesRemoved: acc.filesChanged.linesRemoved + delta.filesChanged.linesRemoved,
    },
    commands: {
      test: acc.commands.test + delta.commands.test,
      build: acc.commands.build + delta.commands.build,
      lint: acc.commands.lint + delta.commands.lint,
      git: acc.commands.git + delta.commands.git,
      install: acc.commands.install + delta.commands.install,
      other: acc.commands.other + delta.commands.other,
    },
    tests,
    errors: {
      toolFailures: acc.errors.toolFailures + delta.errors.toolFailures,
      apiErrors: acc.errors.apiErrors + delta.errors.apiErrors,
      interrupts: acc.errors.interrupts + delta.errors.interrupts,
    },
    models: union(acc.models, delta.models),
    harnessVersion: delta.harnessVersion,
    gitCommits: (acc.gitCommits ?? 0) + (delta.gitCommits ?? 0),
    prUrlsCount: (acc.prUrlsCount ?? 0) + (delta.prUrlsCount ?? 0),
    userCorrections: (acc.userCorrections ?? 0) + (delta.userCorrections ?? 0),
  };
}

/** Total tool calls including MCP calls. */
export function totalToolCalls(stats: ActivityStats): number {
  let n = 0;
  for (const v of Object.values(stats.toolCalls)) n += v;
  for (const tools of Object.values(stats.mcp)) for (const v of Object.values(tools)) n += v;
  return n;
}
