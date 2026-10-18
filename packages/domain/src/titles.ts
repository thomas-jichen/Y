/**
 * Stats-only titles, size buckets, warmups and segment keys (PLAN §7–8).
 * Titles are built only from numbers, enums and validated tags: never from
 * transcript text.
 */
import type { ActivityStats, SetupSnapshot, SizeBucket, StackTag, TaskIntent } from '@paceline/schema';

/** Total tool calls: built-in tools plus every MCP tool call. */
export function totalToolCalls(stats: Pick<ActivityStats, 'toolCalls' | 'mcp'>): number {
  let n = 0;
  for (const v of Object.values(stats.toolCalls)) n += v;
  for (const server of Object.values(stats.mcp)) for (const v of Object.values(server)) n += v;
  return n;
}

function stripZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** `850`, `1.5k`, `212k`, `1.2M`, `14M` (one decimal under 10, `.0` dropped). */
export function compactCount(n: number): string {
  const v0 = Math.max(0, Math.round(n));
  if (v0 < 1000) return String(v0);
  const [div, unit] = v0 >= 999_500 ? ([1e6, 'M'] as const) : ([1e3, 'k'] as const);
  const v = v0 / div;
  const oneDec = Math.round(v * 10) / 10;
  if (oneDec < 10) return `${stripZero(oneDec.toFixed(1))}${unit}`;
  return `${Math.round(v)}${unit}`;
}

/** Max title length. */
export const TITLE_MAX = 120;

const MODEL_TAG = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,39}$/;

/**
 * Title for stats-only cards (no LLM text), ≤ 120 chars, parts joined with
 * ` · `:
 * 1. `<N> tool calls` (total incl. MCP; `1 tool call`);
 * 2. tokens: `212k tokens` (`k` ≥ 1,000, `M` ≥ 1,000,000, one decimal under 10);
 *    omitted when the total is 0 (unknown);
 * 3. `tests green` / `tests red` when tests ran (`tests.runs > 0`), omitted otherwise;
 * 4. the first of `opts.stackTags`, else the setup's model without the
 *    `claude-` prefix (`opus-5-5`); omitted if the model id has an unusual shape.
 * Example: `38 tool calls · 212k tokens · tests green · next@16`.
 */
export function templatedTitle(stats: ActivityStats, setup: Pick<SetupSnapshot, 'model'>, opts?: { stackTags?: readonly StackTag[] }): string {
  const calls = totalToolCalls(stats);
  const parts = [`${calls} tool call${calls === 1 ? '' : 's'}`];
  if (stats.tokens.total > 0) parts.push(`${compactCount(stats.tokens.total)} tokens`);
  if (stats.tests.runs > 0) parts.push(stats.tests.greenAtEnd ? 'tests green' : 'tests red');
  const tag = opts?.stackTags?.[0];
  if (tag) parts.push(tag);
  else {
    const model = setup.model.replace(/^claude-/, '');
    if (MODEL_TAG.test(model)) parts.push(model);
  }
  let title = parts.join(' · ');
  while (title.length > TITLE_MAX && parts.length > 1) {
    parts.pop();
    title = parts.join(' · ');
  }
  return title.slice(0, TITLE_MAX);
}

/** Size bucket: `S` < 20 tool calls and < 100k tokens; `L` ≥ 80 tool calls or ≥ 1M tokens; else `M`. */
export function sizeBucketFor(stats: ActivityStats): SizeBucket {
  const calls = totalToolCalls(stats);
  const tokens = stats.tokens.total;
  if (calls >= 80 || tokens >= 1_000_000) return 'L';
  if (calls < 20 && tokens < 100_000) return 'S';
  return 'M';
}

/** Warmups are kept for stats and never posted: fewer than 3 tool calls **or** under 2 minutes of wall time. */
export function isWarmup(stats: ActivityStats): boolean {
  return totalToolCalls(stats) < 3 || stats.wallMs < 120_000;
}

/** A segment key. */
export interface SegmentKey {
  /** `<intent with _ → ->-<stackKey>` e.g. `fix-failing-test-vitest` (size is a separate column). */
  slug: string;
  intent: TaskIntent;
  /** Primary stack tag with any `@version` removed, or `general`. */
  stackKey: string;
  /** Major version of the primary tag if present (`16` for `next@16`). */
  majorVersion: string | null;
  sizeBucket: SizeBucket;
}

/** Primary-tag priority: test runners, then frameworks, then languages. */
export const STACK_PRIORITY: readonly (readonly string[])[] = [
  ['vitest', 'jest', 'pytest', 'mocha', 'playwright', 'cypress', 'rspec', 'junit', 'go-test', 'cargo-test'],
  [
    'next', 'react', 'vue', 'nuxt', 'svelte', 'sveltekit', 'angular', 'remix', 'astro', 'solid', 'expo', 'react-native',
    'express', 'hono', 'fastify', 'nestjs', 'django', 'flask', 'fastapi', 'rails', 'laravel', 'spring', 'phoenix',
    'supabase', 'prisma', 'drizzle', 'tailwind', 'vite', 'webpack', 'electron', 'tauri',
  ],
  ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'swift', 'ruby', 'php', 'c#', 'csharp', 'c++', 'cpp', 'c', 'elixir', 'scala', 'dart'],
];

function slugPart(s: string): string {
  return s
    .replace(/\+/g, 'p')
    .replace(/#/g, 'sharp')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Organic segment key (intent × stack × size). The primary stack tag is the
 * first tag that is a framework/runner (by {@link STACK_PRIORITY}: test
 * runners, frameworks, then languages), else the first tag, else `general`.
 * Deterministic.
 */
export function segmentKey(input: { intent: TaskIntent; stackTags: readonly StackTag[]; sizeBucket: SizeBucket }): SegmentKey {
  const base = (t: string) => t.split('@')[0] ?? t;
  let primary: string | undefined;
  for (const tier of STACK_PRIORITY) {
    primary = input.stackTags.find((t) => tier.includes(base(t)));
    if (primary) break;
  }
  primary ??= input.stackTags[0];
  const stackKey = primary ? base(primary) : 'general';
  const version = primary?.split('@')[1];
  const major = version?.match(/^(\d+)/)?.[1] ?? null;
  const slug = `${input.intent.replace(/_/g, '-')}-${slugPart(stackKey) || 'general'}`.slice(0, 80).replace(/-$/, '');
  return { slug, intent: input.intent, stackKey, majorVersion: major, sizeBucket: input.sizeBucket };
}
