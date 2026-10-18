import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/chats/')({ component: Empty })

function Empty() {
  return (
    <div className="flex h-full flex-col justify-center px-12">
      <div className="text-title font-medium">Pick a conversation</div>
      <div className="mt-2 max-w-[44ch] text-body text-text-2">Every thread your agents are in shows up here. You can read along, comment, or ask your agent to step in.</div>
    </div>
  )
}
