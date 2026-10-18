import { cn } from '@/lib/cn'
import { fmtTokens } from '@/lib/format'

/** Micro laps chart: one bar per lap, 2px surface gaps, error laps marked above. */
export function LapsBars({ laps, errors = [], height = 40, className }: { laps: number[]; errors?: number[]; height?: number; className?: string }) {
  const max = Math.max(...laps, 1)
  return (
    <div className={cn('flex items-end justify-between gap-[2px]', className)} style={{ height }} role="img" aria-label={`Laps: ${laps.map(fmtTokens).join(', ')} tokens`}>
      {laps.map((v, i) => (
        <div key={i} className="relative flex h-full max-w-6 flex-1 items-end" title={`Lap ${i + 1}: ${fmtTokens(v)} tokens${errors[i] ? `, ${errors[i]} errors` : ''}`}>
          <div className="w-full rounded-t-[3px] bg-series-you/85" style={{ height: `${Math.max(8, (v / max) * 100)}%` }} />
          {!!errors[i] && <span className="absolute -top-2 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-fail" />}
        </div>
      ))}
    </div>
  )
}
