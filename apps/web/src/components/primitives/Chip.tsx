import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'neutral' | 'ice' | 'live' | 'warn' | 'fail' | 'outline' | 'inverse'

const tones: Record<Tone, string> = {
  neutral: 'bg-raised text-fg-2',
  ice: 'bg-ice-wash text-ice',
  live: 'bg-live/12 text-live',
  warn: 'bg-warn/12 text-warn',
  fail: 'bg-fail/12 text-fail',
  outline: 'border border-line text-fg-2',
  inverse: 'bg-inverse text-inverse-fg',
}

export function Chip({
  tone = 'neutral',
  icon,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; icon?: ReactNode }) {
  return (
    <span
      className={cn('inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium', tones[tone], className)}
      {...props}
    >
      {icon}
      {children}
    </span>
  )
}
