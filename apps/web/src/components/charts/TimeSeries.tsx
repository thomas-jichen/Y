import { area, curveMonotoneX, line } from 'd3-shape'
import { scaleLinear, scaleTime } from 'd3-scale'
import { useState } from 'react'
import { ChartTooltip, TipRow } from './ChartTooltip'
import { useSize } from './useSize'

export interface Series {
  key: string
  label: string
  color: string
  values: number[]
  area?: boolean
}

const M = { top: 12, right: 12, bottom: 26, left: 44 }

/** Line or area over time. One axis, recessive grid, crosshair that snaps to the nearest day. */
export function TimeSeries({ dates, series, height = 220, format }: { dates: string[]; series: Series[]; height?: number; format: (n: number) => string }) {
  const [ref, w] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const iw = Math.max(0, w - M.left - M.right)
  const ih = height - M.top - M.bottom
  const ds = dates.map((d) => new Date(d))
  const x = scaleTime().domain([ds[0], ds[ds.length - 1]]).range([0, iw])
  const max = Math.max(...series.flatMap((s) => s.values), 1)
  const y = scaleLinear().domain([0, max * 1.08]).nice(4).range([ih, 0])
  const ticksX = x.ticks(Math.min(6, Math.max(2, Math.floor(iw / 110))))
  const mk = (vals: number[]) => line<number>().x((_, i) => x(ds[i])).y((v) => y(v)).curve(curveMonotoneX)(vals) ?? ''
  const mkArea = (vals: number[]) => area<number>().x((_, i) => x(ds[i])).y0(ih).y1((v) => y(v)).curve(curveMonotoneX)(vals) ?? ''

  const onMove = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect()
    const px = e.clientX - r.left - M.left
    const t = x.invert(px).getTime()
    let best = 0
    ds.forEach((d, i) => {
      if (Math.abs(d.getTime() - t) < Math.abs(ds[best].getTime() - t)) best = i
    })
    setHover(best)
  }

  return (
    <div ref={ref} className="relative" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={series.map((s) => s.label).join(' and ')}>
          <g transform={`translate(${M.left},${M.top})`}>
            {y.ticks(4).map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line x2={iw} stroke="var(--line)" />
                <text x={-10} dy="0.32em" textAnchor="end" className="fill-[var(--fg-3)] text-[11px] tnum">
                  {format(t)}
                </text>
              </g>
            ))}
            {ticksX.map((t) => (
              <text key={t.toISOString()} x={x(t)} y={ih + 18} textAnchor="middle" className="fill-[var(--fg-3)] text-[11px]">
                {t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </text>
            ))}
            {series.map((s) => (
              <g key={s.key}>
                {s.area && <path d={mkArea(s.values)} fill={s.color} opacity={0.1} />}
                <path d={mk(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            ))}
            {hover !== null && (
              <g>
                <line x1={x(ds[hover])} x2={x(ds[hover])} y2={ih} stroke="var(--line-strong)" />
                {series.map((s) => (
                  <circle key={s.key} cx={x(ds[hover])} cy={y(s.values[hover])} r={4} fill={s.color} stroke="var(--surface-solid)" strokeWidth={2} />
                ))}
              </g>
            )}
            <line y1={ih} y2={ih} x2={iw} stroke="var(--line-strong)" />
          </g>
        </svg>
      )}
      {hover !== null && w > 0 && (
        <ChartTooltip x={M.left + x(ds[hover])} y={M.top + y(Math.max(...series.map((s) => s.values[hover])))} align={x(ds[hover]) > iw * 0.75 ? 'right' : x(ds[hover]) < iw * 0.2 ? 'left' : 'center'}>
          <div className="mb-1 text-fg-3">{ds[hover].toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</div>
          {series.map((s) => (
            <TipRow key={s.key} color={s.color} value={format(s.values[hover])} label={s.label} />
          ))}
        </ChartTooltip>
      )}
    </div>
  )
}

export function Legend({ items }: { items: { label: string; color: string; kind?: 'line' | 'rect' }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-fg-2">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          {i.kind === 'rect' ? (
            <span className="inline-block size-2.5 rounded-[3px]" style={{ background: i.color }} />
          ) : (
            <span className="inline-block h-0 w-3" style={{ borderTop: `2px solid ${i.color}` }} />
          )}
          {i.label}
        </span>
      ))}
    </div>
  )
}
