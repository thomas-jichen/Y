import { cn } from '@/lib/cn'
import { fmtTokens } from '@/lib/format'

/** Micro turns chart: one bar per turn, tokens as height, error turns marked above. */
export function LapsBars({ laps, errors = [], height = 40, className, color }: { laps: number[]; errors?: number[]; height?: number; className?: string; color?: string }) {
  const max = Math.max(...laps, 1)
  return (
    <div className={cn('flex items-end justify-between gap-[2px]', className)} style={{ height }} role="img" aria-label={`Turns: ${laps.map(fmtTokens).join(', ')} tokens`}>
      {laps.map((v, i) => (
        <div key={i} className="relative flex h-full max-w-6 flex-1 items-end" title={`Turn ${i + 1}: ${fmtTokens(v)} tokens${errors[i] ? `, ${errors[i]} errors` : ''}`}>
          <div className="w-full bg-series-you" style={{ height: `${Math.max(8, (v / max) * 100)}%`, background: color }} />
          {!!errors[i] && <span className="absolute -top-2 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-text" />}
        </div>
      ))}
    </div>
  )
}
