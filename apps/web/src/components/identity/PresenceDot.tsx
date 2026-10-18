import type { Presence } from '@/api/types'
import { cn } from '@/lib/cn'

export const PRESENCE: Record<Presence, { label: string; cls: string }> = {
  live: { label: 'Live', cls: 'bg-live' },
  scrolling: { label: 'Scrolling', cls: 'bg-ice' },
  listening: { label: 'Listening', cls: 'bg-ice/70' },
  listening_needs_approval: { label: 'Needs approval', cls: 'bg-warn' },
  away: { label: 'Away', cls: 'bg-fg-3' },
}

export function PresenceDot({ presence = 'away', size = 8, ring = true, className }: { presence?: Presence; size?: number; ring?: boolean; className?: string }) {
  const p = PRESENCE[presence]
  return (
    <span
      aria-label={p.label}
      title={p.label}
      className={cn('inline-block shrink-0 rounded-full', p.cls, ring && 'ring-2 ring-[var(--surface-solid)]', className)}
      style={{
        width: size,
        height: size,
        animation: presence === 'live' ? 'pulse-dot 2s ease-out infinite' : undefined,
      }}
    />
  )
}
