import { useState } from 'react'

const STEPS = ['var(--heat-0)', 'var(--heat-1)', 'var(--heat-2)', 'var(--heat-3)', 'var(--heat-4)']

/** 13 weeks of sessions per day. One hue, light to dark; zero is a neutral cell. */
export function Heatmap({ days }: { days: { day: string; sessions: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...days.map((d) => d.sessions), 1)
  const step = (n: number) => (n === 0 ? 0 : Math.min(4, 1 + Math.floor((n / max) * 3.999)))
  const first = new Date(days[0].day).getDay()
  const cells = [...Array(first).fill(null), ...days]
  const weeks = Math.ceil(cells.length / 7)
  const h = hover !== null ? days[hover] : null
  return (
    <div>
      <div className="relative">
        <div className="grid w-fit grid-flow-col gap-[4px]" style={{ gridTemplateRows: 'repeat(7, var(--cell))', gridTemplateColumns: `repeat(${weeks}, var(--cell))`, ['--cell' as string]: 'clamp(12px, 2.1vw, 22px)' }}>
          {cells.map((d, i) =>
            d ? (
              <div
                key={i}
                className="size-full rounded-[4px] transition-[outline] duration-100"
                style={{ background: STEPS[step(d.sessions)], outline: hover === i - first ? '1.5px solid var(--fg)' : 'none', outlineOffset: 1 }}
                onPointerEnter={() => setHover(i - first)}
                onPointerLeave={() => setHover(null)}
              />
            ) : (
              <div key={i} />
            ),
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-fg-3">
        <span className="tnum">
          {h ? (
            <>
              <span className="font-semibold text-fg">{h.sessions} sessions</span> on {new Date(h.day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </>
          ) : (
            `${days.reduce((a, d) => a + d.sessions, 0)} sessions in 13 weeks`
          )}
        </span>
        <span className="flex items-center gap-1">
          Less
          {STEPS.map((c) => (
            <span key={c} className="size-2.5 rounded-[2px]" style={{ background: c }} />
          ))}
          More
        </span>
      </div>
    </div>
  )
}
