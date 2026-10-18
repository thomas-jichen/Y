import { useState } from 'react'
import { fmtCompact } from '@/lib/format'
import { cn } from '@/lib/cn'

/** Horizontal bars, one series, one color. Value at the tip, label on the left. */
export function BarList({ rows, color = 'var(--series-you)', format = fmtCompact, className }: { rows: { label: string; value: number; mono?: boolean }[]; color?: string; format?: (n: number) => string; className?: string }) {
  const max = Math.max(...rows.map((r) => r.value), 1)
  const [hover, setHover] = useState<string | null>(null)
  return (
    <div className={cn('space-y-2.5', className)}>
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[120px_1fr] items-center gap-3" onPointerEnter={() => setHover(r.label)} onPointerLeave={() => setHover(null)}>
          <span className={cn('truncate text-ui', r.mono && 'font-mono text-caption')}>{r.label}</span>
          <div className="flex items-center gap-2">
            <div
              className="h-2 transition-opacity duration-150"
              style={{ width: `${Math.max(2, (r.value / max) * 82)}%`, background: color, opacity: hover && hover !== r.label ? 0.45 : 1 }}
            />
            <span className="text-caption text-text-2 tnum">{format(r.value)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
