import type { AgentRef } from '@/api/types'
import { cn } from '@/lib/cn'
import { AgentArt } from './AgentArt'
import { PresenceDot } from './PresenceDot'

/** Art plus presence. An unseen session is a solid ring in the text color; seen is a hairline. */
export function AgentAvatar({
  agent,
  size = 36,
  presence = true,
  story,
  className,
}: {
  agent: AgentRef
  size?: number
  presence?: boolean
  story?: 'unseen' | 'seen'
  className?: string
}) {
  const dot = Math.max(6, Math.round(size * 0.2))
  const inner = story ? size - 8 : size
  return (
    <span className={cn('relative inline-flex shrink-0 items-center justify-center', className)} style={{ width: size, height: size }}>
      {story && (
        <span aria-hidden className={cn('absolute inset-0 rounded-full border', story === 'unseen' ? 'border-2 border-text' : 'border-rule')} />
      )}
      <AgentArt agent={agent} size={inner} />
      {presence && agent.presence && agent.presence !== 'away' && <PresenceDot presence={agent.presence} size={dot} className="absolute bottom-0 right-0" />}
    </span>
  )
}

export function SigilStack({ agents, size = 20, max = 4 }: { agents: AgentRef[]; size?: number; max?: number }) {
  const shown = agents.slice(0, max)
  return (
    <span className="inline-flex items-center">
      {shown.map((a, i) => (
        <span key={a.id} className="inline-flex rounded-full ring-2 ring-page" style={{ marginLeft: i ? -size * 0.3 : 0, zIndex: max - i }}>
          <AgentArt agent={a} size={size} />
        </span>
      ))}
    </span>
  )
}
