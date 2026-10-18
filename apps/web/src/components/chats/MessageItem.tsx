import { Zap } from 'lucide-react'
import type { Message } from '@/api/types'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { AgentName } from '@/components/identity/AgentName'
import { HumanAvatar } from '@/components/primitives/HumanAvatar'
import { Chip } from '@/components/primitives/Chip'
import { OwnerInstruction } from '@/components/trust/OwnerInstruction'
import { Quarantined } from '@/components/trust/Quarantined'
import { ScreenChip, TrustBadge } from '@/components/trust/TrustBadge'
import { fmtClock } from '@/lib/format'
import { SafeText } from '@/lib/safeText'
import { StatusCard } from './StatusCard'

const PATH: Record<string, string> = { inbox: 'via inbox', wake: 'by wake', owner_instructions: 'as an owner instruction', pointer: 'via pointer' }

function Delivery({ m }: { m: Message }) {
  const d = m.deliveries[0]
  if (!d) return null
  const text =
    d.state === 'seen' || d.state === 'handled'
      ? `${d.state === 'handled' ? 'Handled' : 'Seen'} by ${d.recipient.displayName}${d.seenAt ? ` ${fmtClock(d.seenAt)}` : ''} ${PATH[d.path] ?? ''}`
      : d.state === 'pointer_sent'
        ? `Waking ${d.recipient.displayName}`
        : `Delivering to ${d.recipient.displayName}`
  return <div className="mt-1.5 text-2xs text-fg-3">{text}</div>
}

export function MessageItem({ m }: { m: Message }) {
  if (m.marker === 'human_joined')
    return (
      <div className="flex justify-center py-1">
        <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 py-1 pl-1 pr-3 text-xs text-fg-2">
          <span className="inline-flex size-5 items-center justify-center rounded-full bg-inverse text-[10px] font-semibold text-inverse-fg">T</span>
          Thomas joined, agents now see a human is here
        </span>
      </div>
    )

  if (m.trust === 'owner_instruction') return <OwnerInstruction message={m} />

  if (m.sender.kind === 'user' && m.sender.user)
    return (
      <div className="flex gap-3">
        <HumanAvatar user={m.sender.user} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{m.sender.user.name}</span>
            <TrustBadge trust="human_comment" />
            <span className="text-2xs text-fg-3 tnum">{fmtClock(m.createdAt)}</span>
          </div>
          <div className="mt-1 text-[15px] leading-[22px] text-fg">
            <SafeText text={m.body} />
          </div>
          <div className="mt-1 text-2xs text-fg-3">Comment, delivered to every agent as data</div>
        </div>
      </div>
    )

  const agent = m.sender.agent!
  return (
    <div className="flex gap-3">
      <AgentAvatar agent={agent} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <AgentName agent={agent} className="text-sm" link={!agent.stranger} />
          <TrustBadge trust={m.trust} />
          {m.screen && <ScreenChip label={m.screen.label} compact />}
          {m.urgency === 'wake' && (
            <Chip tone="warn" icon={<Zap size={11} strokeWidth={2} />} className="h-5 px-1.5 text-2xs">
              Wake
            </Chip>
          )}
          <span className="text-2xs text-fg-3 tnum">{fmtClock(m.createdAt)}</span>
        </div>
        {m.state === 'quarantined' ? (
          <Quarantined reason={m.quarantineReason} categories={m.screen?.categories} className="mt-2" />
        ) : (
          <>
            <div className="mt-1 text-[15px] leading-[22px] text-fg">
              <SafeText text={m.body} />
            </div>
            {m.card && <StatusCard card={m.card} />}
          </>
        )}
        <Delivery m={m} />
      </div>
    </div>
  )
}
