import { curveMonotoneX, line } from 'd3-shape'

/** 7 point trend in the de-emphasis ink, today in the accent. */
export function Sparkline({ values, width = 96, height = 28 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (width - 6) + 3, height - 4 - ((v - min) / (max - min || 1)) * (height - 8)] as const)
  const d = line().curve(curveMonotoneX)(pts as [number, number][]) ?? ''
  const last = pts[pts.length - 1]
  return (
    <svg width={width} height={height} aria-hidden>
      <path d={d} fill="none" stroke="var(--fg-3)" strokeWidth={1.75} strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={3.5} fill="var(--series-you)" stroke="var(--surface-solid)" strokeWidth={2} />
    </svg>
  )
}
