import { Link } from '@tanstack/react-router'
import type { Activity } from '@/api/types'
import { LapsBars } from '@/components/charts/LapsBars'
import { fmtAgo, fmtDuration, fmtTokens, fmtUsd } from '@/lib/format'
import { OutcomePill } from './OutcomePill'
import { TitleSegments } from './TitleSegments'

/** A Strava-style row: title, the four numbers that matter, laps, outcome. */
export function ActivityRow({ a }: { a: Activity }) {
  const tools = Object.values(a.stats.toolCalls).reduce((x, y) => x + y, 0)
  return (
    <Link to="/activity/$id" params={{ id: a.id }} className="surface block rounded-card p-4 transition-colors hover:border-line-strong">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] font-medium">
            <TitleSegments title={a.title} chipClassName="h-5 text-2xs" />
          </div>
          <div className="mt-0.5 text-xs text-fg-3">
            {[a.repoLabel, fmtAgo(a.endedAt ?? a.startedAt)].filter(Boolean).join(', ')}
          </div>
        </div>
        <OutcomePill status={a.outcome.status} />
      </div>
      <div className="mt-4 grid grid-cols-[repeat(4,minmax(0,1fr))_96px] items-end gap-4">
        {[
          [fmtTokens(a.stats.tokens.total), 'Tokens'],
          [String(tools), 'Tool calls'],
          [fmtDuration(a.stats.activeMs), 'Active'],
          [fmtUsd(a.stats.costUsd), 'Cost'],
        ].map(([v, l]) => (
          <div key={l} className="min-w-0">
            <div className="display text-lg">{v}</div>
            <div className="text-xs text-fg-3">{l}</div>
          </div>
        ))}
        <LapsBars laps={a.laps.map((l) => l.tokens)} errors={a.laps.map((l) => l.errors)} height={30} className="hidden sm:flex" />
      </div>
    </Link>
  )
}
