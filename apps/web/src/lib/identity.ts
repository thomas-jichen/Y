import type { Habits, Trait } from '@/api/types'
import { fmtDuration } from './format'

const pct = (n: number) => `${Math.round(n * 100)}%`

function share(hours: number[], from: number, to: number) {
  const total = hours.reduce((a, b) => a + b, 0) || 1
  let s = 0
  for (let h = from; h !== to; h = (h + 1) % 24) s += hours[h]
  return s / total
}

const TOOL_NAMES: Record<string, string> = { Bash: 'Bash', Read: 'reading', Edit: 'edits', Grep: 'search', Write: 'writes' }

/** Up to three traits, derived only from measured habits. */
export function deriveTraits(h: Habits): Trait[] {
  const c: (Trait & { score: number })[] = []
  const night = share(h.hours, 21, 4)
  if (night > 0.32) c.push({ id: 'night', label: 'Night owl', why: `${pct(night)} of sessions start after 9pm`, score: night + 0.2 })
  const early = share(h.hours, 5, 10)
  if (early > 0.3) c.push({ id: 'early', label: 'Early riser', why: `${pct(early)} of sessions start before 10am`, score: early + 0.2 })
  if (h.testsPerSession >= 3)
    c.push({ id: 'tests', label: 'Test-first', why: `${h.testsPerSession.toFixed(1)} test runs per session`, score: Math.min(1, h.testsPerSession / 5) })
  const tools = Object.entries(h.toolShare).sort((a, b) => b[1] - a[1])
  const [top, topShare] = tools[0] ?? ['Bash', 0]
  if (top === 'Bash' && topShare > 0.34) c.push({ id: 'bash', label: 'Bash-heavy', why: `${pct(topShare)} of tool calls are Bash`, score: topShare })
  if (top === 'Read' && topShare > 0.3) c.push({ id: 'reader', label: 'Careful reader', why: `${pct(topShare)} of tool calls are reads`, score: topShare })
  if (top === 'Edit' && topShare > 0.28) c.push({ id: 'editor', label: 'Surgical editor', why: `${pct(topShare)} of tool calls are edits`, score: topShare })
  if (h.avgSessionMs < 18 * 60000)
    c.push({ id: 'sprinter', label: 'Sprinter', why: `Sessions average ${fmtDuration(h.avgSessionMs)}`, score: 0.7 })
  if (h.avgSessionMs > 55 * 60000)
    c.push({ id: 'marathon', label: 'Marathoner', why: `Sessions average ${fmtDuration(h.avgSessionMs)}`, score: 0.7 })
  if (h.cacheShare > 0.6) c.push({ id: 'cache', label: 'Frugal with cache', why: `${pct(h.cacheShare)} of input served from cache`, score: h.cacheShare - 0.05 })
  if (h.greenRate > 0.8) c.push({ id: 'finisher', label: 'Reliable finisher', why: `${pct(h.greenRate)} of sessions end green`, score: h.greenRate - 0.1 })
  return c
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ score: _score, ...t }) => t)
}

/** One generated line, built from our own measured data, never agent text. */
export function deriveBio(traits: Trait[], h: Habits): string {
  const [a, b] = traits
  const lead = a && b ? `${a.label} and ${b.label.toLowerCase()}.` : a ? `${a.label}.` : 'Still finding its rhythm.'
  const top = Object.entries(h.toolShare).sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'Bash'
  return `${lead} Mostly ${TOOL_NAMES[top] ?? top}, ${fmtDuration(h.avgSessionMs)} sessions, ${pct(h.greenRate)} green.`
}
