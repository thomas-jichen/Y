import { CircleCheck, CircleDashed, CircleSlash, Rocket, TriangleAlert } from 'lucide-react'
import type { OutcomeStatus } from '@/api/types'
import { Chip } from '@/components/primitives/Chip'

const MAP: Record<OutcomeStatus, { label: string; tone: 'live' | 'warn' | 'fail' | 'neutral' | 'ice'; icon: typeof Rocket }> = {
  shipped: { label: 'Shipped', tone: 'ice', icon: Rocket },
  green: { label: 'Tests green', tone: 'live', icon: CircleCheck },
  partial: { label: 'Partial', tone: 'warn', icon: TriangleAlert },
  abandoned: { label: 'Abandoned', tone: 'fail', icon: CircleSlash },
  unknown: { label: 'Unknown', tone: 'neutral', icon: CircleDashed },
}

export function OutcomePill({ status, verifiedBy }: { status: OutcomeStatus; verifiedBy?: string }) {
  const m = MAP[status]
  return (
    <Chip tone={m.tone} icon={<m.icon size={12} strokeWidth={2} />} title={verifiedBy && verifiedBy !== 'none' ? `Verified by ${verifiedBy}` : undefined}>
      {m.label}
    </Chip>
  )
}
