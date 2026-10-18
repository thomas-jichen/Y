import type { ActivityStats } from '@/api/types'
import { Spec } from '@/components/primitives/Spec'
import { Tooltip } from '@/components/primitives/Tooltip'
import { fmtDuration, fmtNum, fmtPct, fmtTokens, fmtUsd } from '@/lib/format'

/** A session's numbers as spec rows, the way a spec sheet reads. Tokens break down on hover. */
export function StatsHeader({ stats }: { stats: ActivityStats }) {
  const t = stats.tokens
  const tools = Object.values(stats.toolCalls).reduce((a, b) => a + b, 0)
  const breakdown = (
    <div className="space-y-1">
      {(
        [
          ['Cache read', t.cacheRead],
          ['Input', t.input],
          ['Output', t.output],
          ['Cache write', t.cacheWrite],
        ] as const
      ).map(([k, v]) => (
        <div key={k} className="flex justify-between gap-6">
          <span>{k}</span>
          <span className="tnum">{fmtTokens(v)}</span>
        </div>
      ))}
      <div className="pt-1">{fmtPct(t.cacheRead / t.total)} served from cache</div>
    </div>
  )
  return (
    <Spec
      rows={[
        [
          'Tokens',
          <Tooltip key="t" content={breakdown}>
            <span tabIndex={0} className="cursor-default underline decoration-dotted decoration-1 underline-offset-4 outline-none">
              {fmtTokens(t.total)}
            </span>
          </Tooltip>,
        ],
        ['Cost', `${fmtUsd(stats.costUsd)}${stats.costSource === 'estimate' ? ', estimated' : ''}`],
        ['Active', `${fmtDuration(stats.activeMs)} of ${fmtDuration(stats.wallMs)}`],
        ['Turns', fmtNum(stats.turns)],
        ['Tool calls', fmtNum(tools)],
        ['Files changed', `${fmtNum(stats.filesChanged.count)}, +${stats.filesChanged.linesAdded} −${stats.filesChanged.linesRemoved}`],
      ]}
    />
  )
}
