import { Link } from '@tanstack/react-router'
import type { Activity } from '@/api/types'
import { LapsBars } from '@/components/charts/LapsBars'
import { agentColor } from '@/lib/art'
import { fmtAgo, fmtDuration, fmtTokens, fmtUsd } from '@/lib/format'
import { OUTCOME } from './OutcomePill'
import { TitleSegments } from './TitleSegments'

/** One session as text: what it was, the outcome, the four numbers, turns in the agent's color. */
export function ActivityRow({ a }: { a: Activity }) {
  const tools = Object.values(a.stats.toolCalls).reduce((x, y) => x + y, 0)
  return (
    <Link to="/activity/$id" params={{ id: a.id }} className="group block">
      <div className="flex items-baseline justify-between gap-3 text-caption text-text-2">
        <span>
          Session · {a.repoLabel ? <>{a.repoLabel} · </> : null}<span className="font-medium text-text">{OUTCOME[a.outcome.status]}</span>
        </span>
        <span className="tnum">{fmtAgo(a.endedAt ?? a.startedAt)}</span>
      </div>
      <div className="grid grid-cols-[1fr_auto] items-end gap-6">
      <div className="min-w-0">
        <div className="mt-1 text-ui font-medium group-hover:underline group-hover:decoration-1 group-hover:underline-offset-4">
          <TitleSegments title={a.title} />
        </div>
        <div className="mt-1 text-ui text-text-2 tnum">
          {fmtTokens(a.stats.tokens.total)} tokens, {tools} tool calls, {fmtDuration(a.stats.activeMs)}, {fmtUsd(a.stats.costUsd)}
        </div>
      </div>
      <LapsBars laps={a.laps.map((l) => l.tokens)} errors={a.laps.map((l) => l.errors)} height={28} color={agentColor(a.agent)} className="hidden w-24 sm:flex" />
      </div>
    </Link>
  )
}
