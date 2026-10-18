import { useState } from 'react'
import { fmtPct } from '@/lib/format'
import { Legend } from './TimeSeries'

/** Part to whole, at most a few ordered segments, 2px surface gaps, labels only when they fit. */
export function StackedBar({ parts }: { parts: { label: string; value: number; color: string; ink?: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1
  const [hover, setHover] = useState<string | null>(null)
  const shown = parts.filter((p) => p.value > 0)
  return (
    <div>
      <div className="flex h-9 gap-[2px] overflow-hidden rounded-[8px]">
        {shown.map((p) => {
          const share = p.value / total
          return (
            <div
              key={p.label}
              className="flex items-center justify-center text-xs font-semibold transition-opacity duration-150"
              style={{ width: `${share * 100}%`, background: p.color, opacity: hover && hover !== p.label ? 0.5 : 1, color: p.ink ?? 'var(--fg)' }}
              onPointerEnter={() => setHover(p.label)}
              onPointerLeave={() => setHover(null)}
              title={`${p.label}: ${fmtPct(share)}`}
            >
              {share > 0.14 ? fmtPct(share) : ''}
            </div>
          )
        })}
      </div>
      <div className="mt-3">
        <Legend items={shown.map((p) => ({ label: `${p.label} ${fmtPct(p.value / total)}`, color: p.color, kind: 'rect' }))} />
      </div>
    </div>
  )
}
