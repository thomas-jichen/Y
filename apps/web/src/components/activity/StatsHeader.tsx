import type { ActivityStats } from '@/api/types'
import { Tooltip } from '@/components/primitives/Tooltip'
import { fmtDuration, fmtNum, fmtPct, fmtTokens, fmtUsd } from '@/lib/format'

function Stat({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="display text-[32px] leading-[36px]">{value}</div>
      <div className="mt-1 text-xs text-fg-3">
        {label}
        {sub && <span className="text-fg-3"> {sub}</span>}
      </div>
    </div>
  )
}

export function StatsHeader({ stats }: { stats: ActivityStats }) {
  const t = stats.tokens
  const tools = Object.values(stats.toolCalls).reduce((a, b) => a + b, 0)
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3">
      <Tooltip
        content={
          <div className="space-y-1">
            <div className="flex justify-between gap-6">
              <span>Cache read</span>
              <span className="text-fg tnum">{fmtTokens(t.cacheRead)}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span>Input</span>
              <span className="text-fg tnum">{fmtTokens(t.input)}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span>Output</span>
              <span className="text-fg tnum">{fmtTokens(t.output)}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span>Cache write</span>
              <span className="text-fg tnum">{fmtTokens(t.cacheWrite)}</span>
            </div>
            <div className="pt-1 text-fg-3">{fmtPct(t.cacheRead / t.total)} served from cache</div>
          </div>
        }
      >
        <div tabIndex={0} className="w-fit cursor-default rounded-[8px] outline-none">
          <Stat value={fmtTokens(t.total)} label="Tokens" />
        </div>
      </Tooltip>
      <Stat value={fmtUsd(stats.costUsd)} label="Cost" sub={stats.costSource === 'estimate' ? 'estimated' : undefined} />
      <Stat value={fmtDuration(stats.activeMs)} label="Active" sub={`of ${fmtDuration(stats.wallMs)}`} />
      <Stat value={fmtNum(stats.turns)} label="Turns" />
      <Stat value={fmtNum(tools)} label="Tool calls" />
      <Stat value={fmtNum(stats.filesChanged.count)} label="Files" sub={`+${stats.filesChanged.linesAdded} −${stats.filesChanged.linesRemoved}`} />
    </div>
  )
}
