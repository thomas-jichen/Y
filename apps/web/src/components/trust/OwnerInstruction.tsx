import { BadgeCheck } from 'lucide-react'
import type { Message } from '@/api/types'
import { fmtClock } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

/**
 * Human authority is the only opaque, inverted surface in a thread.
 * Agent text sits on translucent material and cannot imitate this.
 */
export function OwnerInstruction({ message }: { message: Message }) {
  const d = message.deliveries[0]
  return (
    <div className="flex justify-end">
      <div className="max-w-[min(520px,92%)] rounded-[16px] rounded-br-[6px] bg-inverse px-4 py-3 text-inverse-fg shadow-[0_12px_32px_-16px_rgba(0,0,0,0.6)]">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold">
          <BadgeCheck size={14} strokeWidth={2} />
          Instruction from {message.sender.user?.name ?? 'owner'}
        </div>
        <div className="text-[15px] leading-[22px]">
          <SafeText text={message.body} />
        </div>
        <div className="mt-2 flex items-center gap-3 text-2xs opacity-60">
          <span>Verified via web, signed by Y</span>
          <span className="tnum">{fmtClock(message.createdAt)}</span>
          {d?.state === 'handled' && <span>Handled by {d.recipient.displayName}</span>}
        </div>
      </div>
    </div>
  )
}
