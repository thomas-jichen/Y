import { scaleBand, scaleLinear } from 'd3-scale'
import { useState } from 'react'
import type { Lap } from '@/api/types'
import { ChartTooltip } from '@/components/charts/ChartTooltip'
import { useSize } from '@/components/charts/useSize'
import { fmtTokens } from '@/lib/format'

const H = 180
const M = { top: 16, right: 4, bottom: 26, left: 40 }

export function LapsChart({ laps }: { laps: Lap[] }) {
  const [ref, w] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const iw = Math.max(0, w - M.left - M.right)
  const ih = H - M.top - M.bottom
  const x = scaleBand<number>().domain(laps.map((l) => l.index)).range([0, iw]).paddingInner(0.3).paddingOuter(0.2)
  const y = scaleLinear().domain([0, Math.max(...laps.map((l) => l.tokens)) * 1.1]).nice(4).range([ih, 0])
  const bw = Math.min(24, x.bandwidth())
  const hovered = hover !== null ? laps[hover] : null
  return (
    <div ref={ref} className="relative" style={{ height: H }}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label="Tokens per lap">
          <g transform={`translate(${M.left},${M.top})`}>
            {y.ticks(4).map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line x2={iw} stroke="var(--line)" />
                <text x={-10} dy="0.32em" textAnchor="end" className="fill-[var(--fg-3)] text-[11px] tnum">
                  {fmtTokens(t)}
                </text>
              </g>
            ))}
            {laps.map((l, i) => {
              const cx = (x(l.index) ?? 0) + x.bandwidth() / 2
              const top = y(l.tokens)
              const h = ih - top
              const r = Math.min(4, h)
              return (
                <g key={l.index} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                  <rect x={(x(l.index) ?? 0) - 2} y={0} width={x.bandwidth() + 4} height={ih} fill="transparent" />
                  <path
                    d={`M${cx - bw / 2},${ih} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${ih} Z`}
                    fill="var(--series-you)"
                    opacity={hover === null || hover === i ? 1 : 0.45}
                    className="transition-opacity duration-150"
                  />
                  {l.errors > 0 && <circle cx={cx} cy={top - 9} r={4} fill="var(--fail)" stroke="var(--surface-solid)" strokeWidth={2} />}
                  <text x={cx} y={ih + 18} textAnchor="middle" className="fill-[var(--fg-3)] text-[11px]">
                    Lap {l.index}
                  </text>
                </g>
              )
            })}
            <line y1={ih} y2={ih} x2={iw} stroke="var(--line-strong)" />
          </g>
        </svg>
      )}
      {hovered && (
        <ChartTooltip x={M.left + (x(hovered.index) ?? 0) + x.bandwidth() / 2} y={M.top + y(hovered.tokens)}>
          <div className="font-semibold text-fg tnum">{fmtTokens(hovered.tokens)} tokens</div>
          <div className="text-fg-3">
            Lap {hovered.index}, {hovered.turns} turns, {hovered.toolCalls} tool calls
            {hovered.errors ? `, ${hovered.errors} ${hovered.errors === 1 ? 'error' : 'errors'}` : ''}
          </div>
        </ChartTooltip>
      )}
      <table className="sr-only">
        <tbody>
          {laps.map((l) => (
            <tr key={l.index}>
              <td>Lap {l.index}</td>
              <td>{l.tokens} tokens</td>
              <td>{l.errors} errors</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
