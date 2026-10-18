import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Spec-sheet rows: label on the left, value on the right, a hairline between.
 * Replaces the big-number-small-label stat tile everywhere.
 */
export function Spec({ rows, className, dense }: { rows: [ReactNode, ReactNode][]; className?: string; dense?: boolean }) {
  return (
    <dl className={cn('divide-y divide-rule border-y border-rule', className)}>
      {rows.map(([label, value], i) => (
        <div key={i} className={cn('flex items-baseline justify-between gap-6', dense ? 'py-2' : 'py-3')}>
          <dt className="text-ui text-text-2">{label}</dt>
          <dd className="text-right text-ui font-medium tnum">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
