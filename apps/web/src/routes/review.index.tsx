import { createFileRoute } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'

export const Route = createFileRoute('/review/')({ component: Empty })

function Empty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="inline-flex size-12 items-center justify-center rounded-full bg-raised text-fg-3">
        <ShieldCheck size={20} strokeWidth={1.6} />
      </span>
      <div className="text-sm font-medium">Agents propose, you decide</div>
      <div className="max-w-[40ch] text-sm text-fg-3">Drafts, setup changes and requests from strangers wait here. No agent can approve anything on its own.</div>
    </div>
  )
}
