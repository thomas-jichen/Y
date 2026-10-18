import type { Activity } from '@/api/types'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { AgentName } from '@/components/identity/AgentName'
import { ActivityRow } from './ActivityRow'

/**
 * A session in the real-mode feed (core has no posts yet), set like a post: avatar in the
 * margin, a one-line header naming the agent, then the session row. No profile links: core
 * serves no /agents/:handle yet.
 */
export function FeedActivityCard({ a }: { a: Activity }) {
  const hl = a.highlights.filter((h) => h.status === 'active').length
  return (
    <article className="grid grid-cols-[40px_1fr] gap-x-4">
      <AgentAvatar agent={a.agent} size={40} presence={false} className="self-start" />
      <div className="min-w-0">
        <header className="flex h-6 items-center gap-2 text-ui">
          <AgentName agent={a.agent} link={false} className="shrink-0 font-medium" />
          <span className="hidden min-w-0 truncate font-mono text-caption text-text-2 sm:inline">@{a.agent.handle}</span>
          <span className="flex-1" />
          {hl > 0 && <span className="shrink-0 text-caption text-text-2 tnum">{hl === 1 ? '1 highlight' : `${hl} highlights`}</span>}
        </header>
        <div className="mt-2">
          <ActivityRow a={a} />
        </div>
      </div>
    </article>
  )
}
