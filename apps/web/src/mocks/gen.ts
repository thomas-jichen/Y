import type { Activity, AgentRef, Habits, Lap, SetupCard, UsageDay, UsageRange, UsageSeries } from '@/api/types'
import { rng } from '@/lib/hash'
import { personalities, type Personality } from './cast'

const DAY = 86_400_000
const iso = (t: number) => new Date(t).toISOString()

function gaussHours(p: Personality): number[] {
  const out = Array.from({ length: 24 }, (_, h) => {
    const d = Math.min(Math.abs(h - p.peak), 24 - Math.abs(h - p.peak))
    return Math.exp(-(d * d) / (2 * p.spread * p.spread))
  })
  const sum = out.reduce((a, b) => a + b, 0)
  return out.map((v) => v / sum)
}

export function habitsFor(agent: AgentRef): Habits {
  const p = personalities[agent.id] ?? personalities.ag_thomas_opus
  const r = rng(`habits:${agent.id}`)
  const hours = gaussHours(p)
  const sessionLengths = Array.from({ length: 40 }, () => Math.max(3, p.avgSessionMin * (0.35 + r() * 1.3)))
  return {
    peakHour: p.peak,
    hours,
    avgSessionMs: p.avgSessionMin * 60000,
    sessionLengths,
    testsPerSession: p.testsPerSession,
    toolShare: p.tools,
    cacheShare: p.cacheShare,
    greenRate: p.greenRate,
    tokensPerSession: p.tokensPerSession,
  }
}

function daysOf(range: UsageRange) {
  return range === '7d' ? 7 : range === '30d' ? 30 : 90
}

/** 180 days of deterministic history per agent; ranges slice from it. */
function history(agent: AgentRef, now: number): UsageDay[] {
  const p = personalities[agent.id] ?? personalities.ag_thomas_opus
  const r = rng(`usage:${agent.id}`)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const out: UsageDay[] = []
  for (let i = 179; i >= 0; i--) {
    const t = today.getTime() - i * DAY
    const dow = new Date(t).getDay()
    const weekend = dow === 0 || dow === 6
    const progress = (179 - i) / 179
    const trend = 1 + p.trend * (progress - 0.5) * 2
    const base = p.sessionsPerDay * trend * (weekend ? 0.35 : 1)
    const sessions = Math.max(0, Math.round(base * (0.55 + r() * 0.9) - (r() > 0.93 ? base : 0)))
    const perSession = p.tokensPerSession * (0.7 + r() * 0.6)
    const total = sessions * perSession
    const cacheRead = total * p.cacheShare * (0.92 + r() * 0.12)
    const tokensOut = total * 0.07
    const tokensIn = Math.max(0, total - cacheRead - tokensOut)
    const costUsd = tokensIn * 5e-6 + tokensOut * 25e-6 + cacheRead * 0.5e-6
    const activeMs = sessions * p.avgSessionMin * 60000 * (0.7 + r() * 0.6)
    const green = sessions ? Math.min(1, Math.max(0, p.greenRate + (r() - 0.5) * 0.25)) : 0
    // the vitest-fixer story: tokens to green drift down over the window
    const ttgTrend = agent.id === 'ag_thomas_opus' ? 1.15 - progress * 0.35 : 1 - p.trend * (progress - 0.5) * 0.4
    out.push({
      day: iso(t),
      tokensIn: Math.round(tokensIn),
      tokensOut: Math.round(tokensOut),
      cacheRead: Math.round(cacheRead),
      sessions,
      costUsd,
      activeMs,
      green,
      tokensToGreen: sessions ? Math.round(p.tokensPerSession * 0.82 * ttgTrend * (0.88 + r() * 0.24)) : 0,
    })
  }
  return out
}

const historyCache = new Map<string, UsageDay[]>()

export function usageFor(agent: AgentRef, range: UsageRange, now: number): UsageSeries {
  const key = agent.id
  if (!historyCache.has(key)) historyCache.set(key, history(agent, now))
  const all = historyCache.get(key)!
  const n = daysOf(range)
  const days = all.slice(-n)
  const prior = all.slice(-n * 2, -n)
  const p = personalities[agent.id] ?? personalities.ag_thomas_opus
  const sum = (arr: UsageDay[], f: (d: UsageDay) => number) => arr.reduce((a, d) => a + f(d), 0)
  const tot = (arr: UsageDay[]) => {
    const sessions = sum(arr, (d) => d.sessions)
    return {
      tokens: sum(arr, (d) => d.tokensIn + d.tokensOut + d.cacheRead),
      sessions,
      activeMs: sum(arr, (d) => d.activeMs),
      costUsd: sum(arr, (d) => d.costUsd),
      greenRate: sessions ? sum(arr, (d) => d.green * d.sessions) / sessions : 0,
    }
  }
  const t = tot(days)
  const toolsTotal = t.sessions * 32
  const tools = Object.fromEntries(Object.entries(p.tools).map(([k, v]) => [k, Math.round(v * toolsTotal)]))
  const mcpShare = 0.06
  tools['MCP: y'] = Math.round(toolsTotal * mcpShare)
  let streak = 0
  for (let i = all.length - 1; i >= 0 && all[i].sessions > 0; i--) streak++
  const codex = agent.model === 'codex'
  return {
    agent,
    range,
    days,
    heat: all.slice(-91).map((d) => ({ day: d.day, sessions: d.sessions })),
    hours: habitsFor(agent).hours,
    tools,
    models: codex
      ? { opus: 0, sonnet: 0, haiku: 0 }
      : { opus: p.opusShare, sonnet: p.sonnetShare, haiku: Math.max(0, 1 - p.opusShare - p.sonnetShare) },
    totals: { ...t, cacheShare: sum(days, (d) => d.cacheRead) / Math.max(1, t.tokens) },
    prior: tot(prior),
    streak,
  }
}

export function resetUsageCache() {
  historyCache.clear()
}

// ---------- activities ----------

export function makeSetup(seed: string, model: string, extra: Partial<SetupCard> = {}): SetupCard {
  return {
    id: `su_${seed}`,
    hash: `sha256:${(rng(seed)() * 1e16).toString(16).slice(0, 12)}`,
    model,
    effort: 'high',
    permissionMode: 'acceptEdits',
    components: [
      { kind: 'plugin', name: 'y', version: '0.4.1', contentShared: false },
      { kind: 'plugin', name: 'review-kit', version: '2.3.0', contentShared: false },
      { kind: 'skill', name: 'db-migrate', contentShared: true, sharedComponentId: 'sc_db_migrate', descriptionRedacted: 'Run and verify schema migrations' },
      { kind: 'skill', name: 'commit-msg', contentShared: false, descriptionRedacted: 'Write conventional commit messages' },
      { kind: 'skill', name: 'ts-strict', contentShared: false, descriptionRedacted: 'Keep TypeScript strict and green' },
      { kind: 'mcp_server', name: 'y', contentShared: false },
      { kind: 'mcp_server', name: 'supabase', contentShared: false },
      { kind: 'claude_md_block', name: 'Testing', contentShared: false },
    ],
    ...extra,
  }
}

function makeLaps(seed: string, total: number, count: number, start: number): Lap[] {
  const r = rng(`laps:${seed}`)
  const weights = Array.from({ length: count }, () => 0.4 + r())
  const sum = weights.reduce((a, b) => a + b, 0)
  return weights.map((w, i) => ({
    index: i + 1,
    startedAt: iso(start + i * 4 * 60000),
    turns: 2 + Math.floor(r() * 6),
    tokens: Math.round((w / sum) * total),
    errors: r() > 0.68 ? 1 + Math.floor(r() * 2) : 0,
    toolCalls: 3 + Math.floor(r() * 10),
  }))
}

export interface ActivitySpec {
  id: string
  agent: AgentRef
  title: string
  summary?: string
  minsAgo: number
  tokens: number
  toolCalls: number
  activeMin: number
  costUsd: number
  outcome: Activity['outcome']['status']
  verifiedBy?: Activity['outcome']['verifiedBy']
  repoLabel?: string
  visibility?: Activity['visibility']
  source?: Activity['source']
  taskIntent?: string
  stackTags?: string[]
  laps?: number
  highlights?: Activity['highlights']
  counts?: Partial<Activity['counts']>
  segment?: Activity['segment']
}

export function makeActivity(s: ActivitySpec, now: number): Activity {
  const r = rng(`act:${s.id}`)
  const p = personalities[s.agent.id] ?? personalities.ag_thomas_opus
  const start = now - s.minsAgo * 60000 - s.activeMin * 60000 * 1.3
  const cacheRead = Math.round(s.tokens * p.cacheShare * 0.97)
  const output = Math.round(s.tokens * 0.07)
  const cacheWrite = Math.round(s.tokens * 0.02)
  const input = s.tokens - cacheRead - output - cacheWrite
  const tools = Object.entries(p.tools)
  const toolCalls: Record<string, number> = {}
  let left = s.toolCalls
  tools.forEach(([name, share], i) => {
    const v = i === tools.length - 1 ? left : Math.min(left, Math.round(share * s.toolCalls))
    toolCalls[name] = v
    left -= v
  })
  const testRuns = Math.max(1, Math.round(p.testsPerSession * (0.8 + r() * 0.6)))
  const green = s.outcome === 'shipped' || s.outcome === 'green'
  return {
    id: s.id,
    agent: s.agent,
    teamSlug: 'acme',
    repoLabel: s.repoLabel ?? 'acme/api',
    kind: 'work',
    source: s.source ?? 'captured',
    visibility: s.visibility ?? 'team',
    status: 'published',
    title: s.title,
    summary: s.summary,
    taskIntent: s.taskIntent ?? 'fix_bug',
    stackTags: s.stackTags ?? ['typescript', 'postgres', 'vitest'],
    sizeBucket: s.tokens > 300_000 ? 'L' : s.tokens > 120_000 ? 'M' : 'S',
    outcome: { status: s.outcome, verifiedBy: s.verifiedBy ?? (green ? 'tests' : 'none') },
    stats: {
      tokens: { input, output, cacheRead, cacheWrite, subagents: Math.round(s.tokens * 0.04), total: s.tokens },
      costUsd: s.costUsd,
      costSource: 'harness',
      activeMs: s.activeMin * 60000,
      wallMs: s.activeMin * 60000 * 1.35,
      turns: Math.round(s.toolCalls * 0.6),
      toolCalls,
      mcp: { y: { search_network: 2, get_item: 1 }, supabase: { execute_sql: 3 } },
      skillsInvoked: ['db-migrate', 'commit-msg'],
      subagents: { count: 1, types: ['explore'] },
      filesChanged: { count: 3 + Math.floor(r() * 8), byExt: { ts: 4, sql: 1, json: 1 }, linesAdded: 40 + Math.floor(r() * 200), linesRemoved: 10 + Math.floor(r() * 60) },
      commands: { test: testRuns, build: 1, lint: 2, git: 4, install: 0, other: 3 },
      tests: { runs: testRuns, last: { passed: green ? 214 : 209, failed: green ? 0 : 5, framework: 'vitest' }, greenAtEnd: green, confidence: green ? 0.94 : 0.4 },
      errors: { toolFailures: Math.floor(r() * 4), apiErrors: 0, interrupts: r() > 0.7 ? 1 : 0 },
      models: [s.agent.modelLabel],
      harnessVersion: s.agent.harness === 'codex' ? '0.98.0' : '2.1.299',
    },
    laps: makeLaps(s.id, s.tokens, s.laps ?? 5, start),
    setup: makeSetup(s.agent.id, s.agent.modelLabel),
    highlights: s.highlights ?? [],
    segment: s.segment,
    counts: { kudos: 0, comments: 0, usedBy: 0, helpedMeasured: 0, adopted: 0, ...s.counts },
    viewer: { gaveKudos: false, isOwner: s.agent.owner.id === 'u_thomas' },
    startedAt: iso(start),
    endedAt: iso(now - s.minsAgo * 60000),
    publishedAt: iso(now - s.minsAgo * 60000),
  }
}

const HISTORY_TITLES = [
  'Fixed flaky snapshot in ledger tests',
  'Added retries to the webhook consumer',
  'Migrated auth middleware to the new session API',
  'Cleaned up unused feature flags',
  'Paginated the invoices endpoint',
  'Upgraded vitest and fixed two broken mocks',
  'Wrote the rollback path for migration 0041',
  'Split the export job into batches',
]

export function historyFor(agent: AgentRef, now: number): Activity[] {
  const p = personalities[agent.id] ?? personalities.ag_thomas_opus
  const r = rng(`hist:${agent.id}`)
  return HISTORY_TITLES.map((title, i) => {
    const tokens = Math.round(p.tokensPerSession * (0.5 + r()))
    return makeActivity(
      {
        id: `h_${agent.handle}_${i}`,
        agent,
        title,
        minsAgo: 60 * 6 + i * 60 * 9 + Math.floor(r() * 120),
        tokens,
        toolCalls: 14 + Math.floor(r() * 40),
        activeMin: Math.round(p.avgSessionMin * (0.5 + r())),
        costUsd: tokens * 0.0000085,
        outcome: r() < p.greenRate ? (r() > 0.6 ? 'shipped' : 'green') : r() > 0.5 ? 'partial' : 'abandoned',
        laps: 3 + Math.floor(r() * 4),
      },
      now,
    )
  })
}
