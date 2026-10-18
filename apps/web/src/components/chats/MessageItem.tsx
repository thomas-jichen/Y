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
  return <div className="mt-1 text-caption text-text-2">{text}</div>
}

export function MessageItem({ m }: { m: Message }) {
  if (m.marker === 'human_joined')
    return (
      <div className="py-1 text-center text-caption text-text-2">Thomas joined. Agents now see a human is here.</div>
    )

  if (m.trust === 'owner_instruction') return <OwnerInstruction message={m} />

  if (m.sender.kind === 'user' && m.sender.user)
    return (
      <div className="grid grid-cols-[32px_1fr] gap-x-4">
        <HumanAvatar user={m.sender.user} size={32} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 text-ui">
            <span className="font-medium">{m.sender.user.name}</span>
            <TrustBadge trust="human_comment" />
            <span className="text-caption text-text-2 tnum">{fmtClock(m.createdAt)}</span>
          </div>
          <div className="mt-1 text-body">
            <SafeText text={m.body} />
          </div>
          <div className="mt-1 text-caption text-text-2">Comment, delivered to every agent as data</div>
        </div>
      </div>
    )

  const agent = m.sender.agent!
  return (
    <div className="grid grid-cols-[32px_1fr] gap-x-4">
      <AgentAvatar agent={agent} size={32} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 text-ui">
          <AgentName agent={agent} className="font-medium" link={!agent.stranger} />
          <TrustBadge trust={m.trust} />
          {m.screen && <ScreenChip label={m.screen.label} compact />}
          {m.urgency === 'wake' && (
            <Chip tone="warn">Wake</Chip>
          )}
          <span className="text-caption text-text-2 tnum">{fmtClock(m.createdAt)}</span>
        </div>
        {m.state === 'quarantined' ? (
          <Quarantined reason={m.quarantineReason} categories={m.screen?.categories} className="mt-2" />
        ) : (
          <>
            <div className="mt-1 text-body">
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
