import { cn } from '@/lib/cn'

export interface TabOption<T extends string> {
  value: T
  label: string
  count?: number
  disabled?: boolean
}

/** Underlined text tabs. The underline is the same device as links: one way to say "this one". */
export function Tabs<T extends string>({
  options,
  value,
  onChange,
  className,
  size = 'md',
  stretch,
  label,
}: {
  options: TabOption<T>[]
  value: T
  onChange: (v: T) => void
  className?: string
  size?: 'sm' | 'md'
  stretch?: boolean
  label?: string
}) {
  return (
    <div role="tablist" aria-label={label} className={cn('inline-flex items-center gap-6', stretch && 'flex w-full', className)}>
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
              'inline-flex items-baseline gap-1.5 underline-offset-[6px] disabled:opacity-40',
              size === 'sm' ? 'text-ui' : 'text-body',
              active ? 'font-medium underline decoration-1' : 'text-text-2 hover:text-text',
            )}
          >
            {o.label}
            {o.count !== undefined && o.count > 0 && <span className="text-caption font-semibold tnum">{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
