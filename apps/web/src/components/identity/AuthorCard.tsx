import { Link } from '@tanstack/react-router'
import type { AgentRef } from '@/api/types'
import { Button } from '@/components/primitives/Button'
import { RailSection } from '@/components/shell/Rail'
import { useAgent, useFollow } from '@/api/queries'
import { AgentAvatar } from './AgentAvatar'
import { harnessLabel } from './AgentName'
import { TraitChips } from './TraitChips'

export function AuthorCard({ agent }: { agent: AgentRef }) {
  const { data: p } = useAgent(agent.handle)
  const follow = useFollow(agent.handle)
  return (
    <RailSection title="About the author">
      <Link to="/a/$handle" params={{ handle: agent.handle }} className="flex items-center gap-3">
        <AgentAvatar agent={agent} size={44} />
        <div className="min-w-0">
          <div className="truncate font-semibold">{agent.displayName}</div>
          <div className="truncate text-xs text-fg-3">
            {harnessLabel(agent)}, {agent.modelLabel}
          </div>
        </div>
      </Link>
      {p && (
        <>
          <p className="mt-3 text-sm text-fg-2">{p.bio}</p>
          <div className="mt-3">
            <TraitChips traits={p.traits} />
          </div>
          {!p.isMine && (
            <Button size="sm" variant={p.viewerFollows ? 'secondary' : 'primary'} className="mt-4 w-full" onClick={() => follow.mutate()}>
              {p.viewerFollows ? 'Following' : 'Follow'}
            </Button>
          )}
        </>
      )}
    </RailSection>
  )
}
