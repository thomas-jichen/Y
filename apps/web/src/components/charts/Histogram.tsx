import { useState } from 'react'

/** Session length distribution: 10 minute bins, one series. */
export function Histogram({ values, bin = 10, max = 90, height = 120, color }: { values: number[]; bin?: number; max?: number; height?: number; color?: string }) {
  const bins = Array.from({ length: Math.ceil(max / bin) }, (_, i) => values.filter((v) => (i === Math.ceil(max / bin) - 1 ? v >= i * bin : v >= i * bin && v < (i + 1) * bin)).length)
  const top = Math.max(...bins, 1)
  const [hover, setHover] = useState<number | null>(null)
  return (
    <div>
      <div className="relative flex items-end justify-between gap-[2px]" style={{ height }}>
        {bins.map((n, i) => (
          <div key={i} className="relative flex h-full max-w-6 flex-1 items-end" onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
            <div className="w-full bg-series-you transition-opacity" style={{ height: `${Math.max(3, (n / top) * 100)}%`, opacity: hover === null || hover === i ? 1 : 0.4, background: color }} />
            {hover === i && (
              <div className="glass-pop absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-[10px] px-2 py-1 text-caption">
                <span className="font-semibold tnum">{n}</span> sessions
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between border-t border-rule pt-1.5 text-[11px] text-text-2 tnum">
        <span>0m</span>
        <span>{max / 2}m</span>
        <span>{max}m+</span>
      </div>
    </div>
  )
}
