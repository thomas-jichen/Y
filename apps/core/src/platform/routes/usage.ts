/**
 * GET /api/v1/usage?agent=&range= → UsageSeries (packages/schema web.ts): one agent's sessions
 * bucketed per UTC day, with the previous window of equal length and the current streak.
 * Runs under the viewer's RLS (I7): the agent must be visible to the viewer, and only the
 * activities RLS shows count (the owner sees every status; teammates see published ones).
 */
import type { Hono } from 'hono';
import { USAGE_RANGE_DAYS, UsageQuery, UsageSeries, type UsageDay, type UsageRange, type UsageTotals } from '@y/schema';
import type { CoreDeps } from '../../contracts.js';
import { agentInfos, agentRef } from '../../messaging/util.js';
import { authenticate } from '../http.js';
import { fail, num, parseOr } from '../util.js';

const DAY = 86_400_000;
/** Streak lookback: a streak longer than this reads as this many days. */
const STREAK_MAX_DAYS = 400;
const ROW_LIMIT = 20_000;

/** One activity as the usage math needs it. */
export interface UsageRow {
  startedAt: Date;
  tokensTotal: number;
  activeMs: number;
  costUsd: number;
  outcomeStatus: string;
  tokens: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; subagents?: unknown } | null;
  toolCalls: Record<string, unknown> | null;
  mcp: Record<string, Record<string, unknown>> | null;
  models: unknown;
}

const utcDay = (t: number) => Math.floor(t / DAY) * DAY;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const isGreen = (s: string) => s === 'green' || s === 'shipped';

function family(model: string): 'opus' | 'sonnet' | 'haiku' | null {
  const m = model.toLowerCase();
  return m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m.includes('haiku') ? 'haiku' : null;
}

/** In/out/cacheRead for one activity; in + out + cacheRead = tokens_total when the breakdown is present. */
function split(r: UsageRow): { tokensIn: number; tokensOut: number; cacheRead: number } {
  const t = r.tokens ?? {};
  const tokensIn = num(t.input) + num(t.cacheWrite) + num(t.subagents);
  const tokensOut = num(t.output);
  const cacheRead = num(t.cacheRead);
  if (tokensIn + tokensOut + cacheRead === 0 && r.tokensTotal > 0) return { tokensIn: r.tokensTotal, tokensOut: 0, cacheRead: 0 };
  return { tokensIn, tokensOut, cacheRead };
}

function totals(days: UsageDay[]): UsageTotals {
  const s = (f: (d: UsageDay) => number) => days.reduce((a, d) => a + f(d), 0);
  const sessions = s((d) => d.sessions);
  return {
    tokens: s((d) => d.tokensIn + d.tokensOut + d.cacheRead),
    sessions,
    activeMs: s((d) => d.activeMs),
    costUsd: round6(s((d) => d.costUsd)),
    greenRate: sessions ? s((d) => d.green) / sessions : 0,
  };
}

/** Pure: rows of the current and prior windows (+ session days for the streak) → UsageSeries minus the agent. */
export function buildUsage(
  rows: readonly UsageRow[],
  sessionDays: ReadonlySet<string>,
  range: UsageRange,
  now: Date,
): Omit<UsageSeries, 'agent'> {
  const n = USAGE_RANGE_DAYS[range];
  const today = utcDay(now.getTime());
  const first = today - (n - 1) * DAY;
  const priorFirst = first - n * DAY;
  const blank = (t: number): UsageDay & { greenTokens: number } => ({
    day: new Date(t).toISOString(),
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    sessions: 0,
    costUsd: 0,
    activeMs: 0,
    green: 0,
    tokensToGreen: 0,
    greenTokens: 0,
  });
  const cur = Array.from({ length: n }, (_, i) => blank(first + i * DAY));
  const prior = Array.from({ length: n }, (_, i) => blank(priorFirst + i * DAY));
  const hourCounts = new Array<number>(24).fill(0);
  const tools: Record<string, number> = {};
  const fam = { opus: 0, sonnet: 0, haiku: 0 };
  const modelTokens = new Map<string, number>();

  for (const r of rows) {
    const t = r.startedAt.getTime();
    const d = utcDay(t);
    const inCur = d >= first && d <= today;
    const bucket = inCur ? cur[(d - first) / DAY] : d >= priorFirst && d < first ? prior[(d - priorFirst) / DAY] : undefined;
    if (!bucket) continue;
    const tk = split(r);
    const total = tk.tokensIn + tk.tokensOut + tk.cacheRead;
    bucket.tokensIn += tk.tokensIn;
    bucket.tokensOut += tk.tokensOut;
    bucket.cacheRead += tk.cacheRead;
    bucket.sessions += 1;
    bucket.costUsd += r.costUsd;
    bucket.activeMs += r.activeMs;
    if (isGreen(r.outcomeStatus)) {
      bucket.green += 1;
      bucket.greenTokens += total;
    }
    if (!inCur) continue;
    hourCounts[r.startedAt.getUTCHours()]! += 1;
    for (const [k, v] of Object.entries(r.toolCalls ?? {})) tools[k] = (tools[k] ?? 0) + num(v);
    for (const [server, calls] of Object.entries(r.mcp ?? {})) {
      const k = `MCP: ${server}`;
      tools[k] = (tools[k] ?? 0) + Object.values(calls ?? {}).reduce<number>((a, v) => a + num(v), 0);
    }
    const models = Array.isArray(r.models) ? r.models.filter((m): m is string => typeof m === 'string') : [];
    const fams = [...new Set(models.map(family).filter((f) => f !== null))];
    for (const f of fams) fam[f] += total / fams.length;
    for (const m of models) modelTokens.set(m, (modelTokens.get(m) ?? 0) + total / models.length);
  }

  const finish = (b: UsageDay & { greenTokens: number }): UsageDay => {
    const { greenTokens, ...day } = b;
    return { ...day, costUsd: round6(day.costUsd), tokensToGreen: day.green ? Math.round(greenTokens / day.green) : 0 };
  };
  const days = cur.map(finish);
  const t = totals(days);
  const sessions = hourCounts.reduce((a, b) => a + b, 0);
  const famTotal = fam.opus + fam.sonnet + fam.haiku;
  let streak = 0;
  for (let d = today; streak < STREAK_MAX_DAYS && sessionDays.has(new Date(d).toISOString().slice(0, 10)); d -= DAY) streak++;
  const top = [...modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  return {
    ...(top ? { model: top } : {}),
    range,
    days,
    heat: days.map((d) => ({ day: d.day, sessions: d.sessions })),
    hours: hourCounts.map((h) => (sessions ? h / sessions : 0)),
    tools,
    models: famTotal
      ? { opus: fam.opus / famTotal, sonnet: fam.sonnet / famTotal, haiku: fam.haiku / famTotal }
      : { opus: 0, sonnet: 0, haiku: 0 },
    totals: { ...t, cacheShare: t.tokens ? days.reduce((a, d) => a + d.cacheRead, 0) / t.tokens : 0 },
    prior: totals(prior.map(finish)),
    streak,
  };
}

export function registerUsageRoutes(app: Hono, deps: CoreDeps): void {
  app.get('/api/v1/usage', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const q = parseOr(c, UsageQuery, c.req.query());
    if (!q.ok) return q.res;
    const handle = q.data.agent.replace(/^@/, '');
    const now = deps.now();
    const today = utcDay(now.getTime());
    const n = USAGE_RANGE_DAYS[q.data.range];
    const end = new Date(today + DAY);
    const from = new Date(today - (2 * n - 1) * DAY);
    const out = await deps.db.asUser(caller.claims, async (tx) => {
      const ag = (await tx.query<{ id: string }>('select id from public.agents where handle = $1', [handle])).rows[0];
      const info = ag ? (await agentInfos(tx, [ag.id])).get(ag.id) : undefined;
      if (!ag || !info) return null;
      // Every session counts (open, drafts, archived warmups...) as far as RLS shows them; scroll reports are not sessions.
      const r = await tx.query<Record<string, unknown>>(
        `select started_at, tokens_total, active_ms, cost_usd, outcome_status::text as outcome_status,
                stats->'tokens' as tokens, stats->'toolCalls' as tool_calls, stats->'mcp' as mcp, stats->'models' as models
           from public.activities
          where agent_id = $1 and kind = 'work' and started_at >= $2 and started_at < $3
          order by started_at limit ${ROW_LIMIT}`,
        [ag.id, from, end],
      );
      const days = await tx.query<{ d: string }>(
        `select distinct to_char(started_at at time zone 'UTC', 'YYYY-MM-DD') as d
           from public.activities where agent_id = $1 and kind = 'work' and started_at >= $2 and started_at < $3`,
        [ag.id, new Date(today - STREAK_MAX_DAYS * DAY), end],
      );
      const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null);
      const rows: UsageRow[] = r.rows.map((x) => ({
        startedAt: x.started_at instanceof Date ? x.started_at : new Date(String(x.started_at)),
        tokensTotal: num(x.tokens_total),
        activeMs: num(x.active_ms),
        costUsd: num(x.cost_usd),
        outcomeStatus: String(x.outcome_status ?? 'unknown'),
        tokens: obj(x.tokens),
        toolCalls: obj(x.tool_calls),
        mcp: obj(x.mcp),
        models: x.models,
      }));
      return { agent: agentRef(info), ...buildUsage(rows, new Set(days.rows.map((x) => x.d)), q.data.range, now) };
    });
    if (!out) return fail(c, 'NOT_FOUND', `no agent @${handle} visible to you`);
    return c.json(UsageSeries.parse(out));
  });
}
