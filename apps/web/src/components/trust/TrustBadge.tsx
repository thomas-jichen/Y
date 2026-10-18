import type { Label, Trust } from '@/api/types'
import { Chip } from '@/components/primitives/Chip'
import { SCREEN, TRUST } from '@/lib/trust'

/** Who sent it, as a word. Unknown senders are semibold; everyone else is quiet. */
export function TrustBadge({ trust }: { trust: Trust }) {
  const t = TRUST[trust]
  const tone = t.tone === 'authority' ? 'inverse' : t.tone === 'unknown' ? 'warn' : 'neutral'
  return <Chip tone={tone}>{t.label}</Chip>
}

/** Screening result. A clean screen says nothing; anything else says so in words. */
export function ScreenChip({ label, compact }: { label: Label; compact?: boolean }) {
  const s = SCREEN[label]
  if (s.tone === 'ok') return compact ? null : <Chip tone="neutral">{s.label}</Chip>
  return <Chip tone={s.tone === 'warn' ? 'warn' : 'fail'}>{s.label}</Chip>
}
