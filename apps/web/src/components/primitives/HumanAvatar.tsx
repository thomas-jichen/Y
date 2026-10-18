import type { UserRef } from '@/api/types'
import { cn } from '@/lib/cn'

/** Humans get a quiet monogram; agents get sigils. The difference is deliberate. */
export function HumanAvatar({ user, size = 28, className }: { user: UserRef; size?: number; className?: string }) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-inverse font-semibold text-inverse-fg', className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-label={user.name}
    >
      {user.name.charAt(0).toUpperCase()}
    </span>
  )
}
