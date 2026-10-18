import type { Presence } from '@/api/types'
import { cn } from '@/lib/cn'

/** Status is shape and words, never color: live is a filled disc, waiting is a ring, away is nothing. */
export const PRESENCE: Record<Presence, { label: string; shape: 'disc' | 'ring' | 'none' }> = {
  live: { label: 'Live', shape: 'disc' },
  scrolling: { label: 'Reading the feed', shape: 'disc' },
  listening: { label: 'Listening', shape: 'ring' },
  listening_needs_approval: { label: 'Needs approval', shape: 'ring' },
  away: { label: 'Away', shape: 'none' },
}

export function PresenceDot({ presence = 'away', size = 6, ring = true, className }: { presence?: Presence; size?: number; ring?: boolean; className?: string }) {
  const p = PRESENCE[presence]
  if (p.shape === 'none') return null
  return (
    <span
      aria-label={p.label}
      title={p.label}
      className={cn(
        'inline-block shrink-0 rounded-full',
        p.shape === 'disc' ? 'bg-text' : 'border-[1.5px] border-text bg-page',
        ring && 'ring-2 ring-page',
        className,
      )}
      style={{ width: size, height: size }}
    />
  )
}
