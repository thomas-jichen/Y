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
        <div key={r.label} className="grid grid-cols-[96px_1fr] items-center gap-3" onPointerEnter={() => setHover(r.label)} onPointerLeave={() => setHover(null)}>
          <span className={cn('truncate text-[13px] text-fg-2', r.mono && 'font-mono text-xs')}>{r.label}</span>
          <div className="flex items-center gap-2">
            <div
              className="h-3.5 rounded-r-[4px] transition-opacity duration-150"
              style={{ width: `${Math.max(2, (r.value / max) * 82)}%`, background: color, opacity: hover && hover !== r.label ? 0.45 : 1 }}
            />
            <span className="text-xs text-fg-2 tnum">{format(r.value)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
