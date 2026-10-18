import { useState } from 'react'
import { fmtPct } from '@/lib/format'

const HOUR_LABEL = (h: number) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`)

/**
 * When an agent works, as a 24 hour clock. One series as bars; a comparison
 * agent rides along as a 2px outline with its own legend entry.
 */
export function RadialClock({
  hours,
  peer,
  size = 260,
  youLabel = 'You',
  peerLabel,
}: {
  hours: number[]
  peer?: number[]
  size?: number
  youLabel?: string
  peerLabel?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const c = size / 2
  const r0 = size * 0.2
  const r1 = size * 0.44
  const max = Math.max(...hours, ...(peer ?? []), 0.0001)
  const ang = (h: number) => ((h / 24) * 360 - 90) * (Math.PI / 180)
  const pt = (h: number, r: number) => [c + r * Math.cos(ang(h)), c + r * Math.sin(ang(h))] as const
  const peak = hours.indexOf(Math.max(...hours))
  const bar = (h: number, v: number) => {
    const r = r0 + (v / max) * (r1 - r0)
    const a0 = h + 0.14
    const a1 = h + 0.86
    const [x0, y0] = pt(a0, r0)
    const [x1, y1] = pt(a0, r)
    const [x2, y2] = pt(a1, r)
    const [x3, y3] = pt(a1, r0)
    return `M${x0},${y0} L${x1},${y1} A${r},${r} 0 0 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 0 0 ${x0},${y0} Z`
  }
  const peerPath =
    peer &&
    peer
      .map((v, h) => {
        const [x, y] = pt(h + 0.5, r0 + (v / max) * (r1 - r0))
        return `${h ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ') + ' Z'
  const shown = hover ?? peak
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} role="img" aria-label={`Activity by hour, peak at ${HOUR_LABEL(peak)}`} className="overflow-visible">
        <circle cx={c} cy={c} r={r1} fill="none" stroke="var(--line)" />
        <circle cx={c} cy={c} r={r0} fill="none" stroke="var(--line)" />
        {[0, 6, 12, 18].map((h) => {
          const [x, y] = pt(h, r1 + 14)
          const [lx, ly] = pt(h, r1)
          const [ix, iy] = pt(h, r0)
          return (
            <g key={h}>
              <line x1={ix} y1={iy} x2={lx} y2={ly} stroke="var(--line)" />
              <text x={x} y={y} dy="0.32em" textAnchor="middle" className="fill-[var(--fg-3)] text-[10px]">
                {HOUR_LABEL(h)}
              </text>
            </g>
          )
        })}
        {hours.map((v, h) => (
          <path
            key={h}
            d={bar(h, v)}
            fill="var(--series-you)"
            opacity={hover === null || hover === h ? 1 : 0.4}
            className="transition-opacity duration-150"
            onPointerEnter={() => setHover(h)}
            onPointerLeave={() => setHover(null)}
          />
        ))}
        {peerPath && <path d={peerPath} fill="none" stroke="var(--series-peer)" strokeWidth={2} strokeLinejoin="round" pointerEvents="none" />}
        <text x={c} y={c - 6} textAnchor="middle" className="fill-[var(--fg)] text-[17px] font-semibold">
          {HOUR_LABEL(shown)}
        </text>
        <text x={c} y={c + 13} textAnchor="middle" className="fill-[var(--fg-3)] text-[11px]">
          {hover === null ? 'Peak hour' : `${fmtPct(hours[shown])} of sessions`}
        </text>
      </svg>
      {peer && (
        <div className="mt-3 flex items-center gap-4 text-xs text-fg-2">
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-[3px] bg-series-you" />
            {youLabel}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0 w-3 border-t-2 border-series-peer" />
            {peerLabel}
          </span>
        </div>
      )}
    </div>
  )
}
