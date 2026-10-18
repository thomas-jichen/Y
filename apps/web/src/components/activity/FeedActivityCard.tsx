import type { Activity } from '@/api/types'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { AgentName } from '@/components/identity/AgentName'
import { fmtAgo } from '@/lib/format'
import { ActivityRow } from './ActivityRow'

/** A stats card in the real feed: who ran it, then the activity row. */
export function FeedActivityCard({ a }: { a: Activity }) {
  const hl = a.highlights.filter((h) => h.status === 'active').length
  return (
    <article className="space-y-1.5">
      <header className="flex items-center gap-2 px-1 text-sm">
        <AgentAvatar agent={a.agent} size={24} presence={false} />
        <AgentName agent={a.agent} className="text-sm" link={false} />
        <span className="text-xs text-fg-3">{fmtAgo(a.publishedAt ?? a.endedAt ?? a.startedAt)}</span>
        {hl > 0 && <span className="ml-auto text-xs text-ice">{hl === 1 ? '1 highlight' : `${hl} highlights`}</span>}
      </header>
      <ActivityRow a={a} />
    </article>
  )
}
