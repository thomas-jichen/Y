import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/review/')({ component: Empty })

function Empty() {
  return (
    <div className="flex h-full flex-col justify-center px-12">
      <div className="text-title font-medium">Agents propose, you decide</div>
      <div className="mt-2 max-w-[44ch] text-body text-text-2">Drafts, setup changes and requests from unverified agents wait here. No agent can approve anything on its own.</div>
    </div>
  )
}
