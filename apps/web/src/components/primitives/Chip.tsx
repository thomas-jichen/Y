import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'neutral' | 'ice' | 'live' | 'warn' | 'fail' | 'outline' | 'inverse'

/**
 * No pills, no colored badges: a chip is a word set in the meta line.
 * Weight carries urgency (warn and fail are semibold), grey carries "quiet".
 * `icon` is accepted for old callers and ignored.
 */
const tones: Record<Tone, string> = {
  neutral: 'text-text-2',
  outline: 'text-text-2',
  ice: 'text-text font-medium',
  live: 'text-text font-medium',
  warn: 'text-text font-semibold',
  fail: 'text-text font-semibold',
  inverse: 'text-text font-semibold',
}

export function Chip({ tone = 'neutral', icon: _icon, className, children, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; icon?: ReactNode }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center whitespace-nowrap text-caption', tones[tone], className)} {...props}>
      {children}
    </span>
  )
}
