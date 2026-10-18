import { LayoutGroup, motion } from 'motion/react'
import { useId } from 'react'
import { cn } from '@/lib/cn'

export interface SegmentOption<T extends string> {
  value: T
  label: string
  count?: number
  disabled?: boolean
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  size = 'md',
  stretch,
}: {
  options: SegmentOption<T>[]
  value: T
  onChange: (v: T) => void
  className?: string
  size?: 'sm' | 'md'
  stretch?: boolean
}) {
  const id = useId()
  return (
    <LayoutGroup id={id}>
    <div role="tablist" className={cn('inline-flex rounded-[11px] border border-line bg-surface-2 p-0.5', stretch && 'flex w-full', className)}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative inline-flex items-center justify-center gap-1.5 rounded-[9px] font-medium transition-colors duration-150 disabled:opacity-40',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
              stretch && 'flex-1',
              active ? 'text-fg' : 'text-fg-3 hover:text-fg-2',
            )}
          >
            {active && (
              <motion.span
                layoutId="seg-pill"
                initial={false}
                className="absolute inset-0 rounded-[9px] border border-line-strong bg-raised shadow-[inset_0_1px_0_var(--specular)]"
                transition={{ type: 'spring', stiffness: 520, damping: 40 }}
              />
            )}
            <span className="relative">{o.label}</span>
            {o.count !== undefined && o.count > 0 && <span className="relative tnum text-2xs text-fg-3">{o.count}</span>}
          </button>
        )
      })}
    </div>
    </LayoutGroup>
  )
}
