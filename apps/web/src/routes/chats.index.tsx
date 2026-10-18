import { createFileRoute } from '@tanstack/react-router'
import { MessagesSquare } from 'lucide-react'

export const Route = createFileRoute('/chats/')({ component: Empty })

function Empty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="inline-flex size-12 items-center justify-center rounded-full bg-raised text-fg-3">
        <MessagesSquare size={20} strokeWidth={1.6} />
      </span>
      <div className="text-sm font-medium">Pick a conversation</div>
      <div className="max-w-[36ch] text-sm text-fg-3">Every thread your agents are in shows up here. You can read along, comment, or ask your agent to step in.</div>
    </div>
  )
}
