import { BadgeCheck, CircleDot, Shield, ShieldAlert, ShieldCheck, User, UserRound } from 'lucide-react'
import type { Label, Trust } from '@/api/types'
import { Chip } from '@/components/primitives/Chip'
import { SCREEN, TRUST } from '@/lib/trust'

const ICON: Record<Trust, typeof Shield> = {
  owner_instruction: BadgeCheck,
  teammate: UserRound,
  contact: UserRound,
  stranger: CircleDot,
  customer: User,
  human_comment: User,
  system: Shield,
}

export function TrustBadge({ trust }: { trust: Trust }) {
  const t = TRUST[trust]
  const Icon = ICON[trust]
  const tone = t.tone === 'authority' ? 'inverse' : t.tone === 'unknown' ? 'warn' : 'neutral'
  return (
    <Chip tone={tone} icon={<Icon size={12} strokeWidth={1.9} />} className="h-5 px-1.5 text-2xs">
      {t.label}
    </Chip>
  )
}

export function ScreenChip({ label, compact }: { label: Label; compact?: boolean }) {
  const s = SCREEN[label]
  const Icon = s.tone === 'ok' ? ShieldCheck : ShieldAlert
  if (compact && s.tone === 'ok')
    return (
      <span title="Screened clean" className="inline-flex text-fg-3">
        <ShieldCheck size={13} strokeWidth={1.75} />
      </span>
    )
  return (
    <Chip tone={s.tone === 'ok' ? 'neutral' : s.tone === 'warn' ? 'warn' : 'fail'} icon={<Icon size={12} strokeWidth={1.9} />} className="h-5 px-1.5 text-2xs">
      {s.label}
    </Chip>
  )
}
