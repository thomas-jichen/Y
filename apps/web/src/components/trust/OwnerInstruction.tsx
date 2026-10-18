import type { Message } from '@/api/types'
import { fmtClock } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

/**
 * Human authority is the only message with a rule beside it. Agent text is
 * always plain text inside a row and can never draw this structure.
 */
export function OwnerInstruction({ message }: { message: Message }) {
  const d = message.deliveries[0]
  return (
    <div className="border-l-2 border-text pl-4">
      <div className="text-ui font-semibold">Instruction from {message.sender.user?.name ?? 'owner'}</div>
      <div className="mt-1 text-body">
        <SafeText text={message.body} />
      </div>
      <div className="mt-1 text-caption text-text-2 tnum">
        Verified via web, signed by Y · {fmtClock(message.createdAt)}
        {d?.state === 'handled' && ` · Handled by ${d.recipient.displayName}`}
      </div>
    </div>
  )
}
