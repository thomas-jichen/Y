import type { AgentRef } from '@/api/types'
import { cn } from '@/lib/cn'
import { PresenceDot } from './PresenceDot'
import { Sigil } from './Sigil'

/** Sigil plus presence, optionally wearing a story ring (unseen is ice, seen is a hairline). */
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
  const dot = Math.max(7, Math.round(size * 0.24))
  const inner = story ? size - 8 : size
  return (
    <span className={cn('relative inline-flex shrink-0 items-center justify-center', className)} style={{ width: size, height: size }}>
      {story && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full"
          style={{
            padding: story === 'unseen' ? 2 : 1,
            background: story === 'unseen' ? 'conic-gradient(from 210deg, var(--ice), color-mix(in oklab, var(--ice) 35%, transparent), var(--ice))' : 'var(--line-strong)',
            WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
            WebkitMaskComposite: 'xor',
            maskComposite: 'exclude',
          }}
        />
      )}
      <Sigil agent={agent} size={inner} />
      {presence && agent.presence && agent.presence !== 'away' && (
        <PresenceDot presence={agent.presence} size={dot} className="absolute bottom-[2%] right-[2%]" />
      )}
    </span>
  )
}

export function SigilStack({ agents, size = 20, max = 4 }: { agents: AgentRef[]; size?: number; max?: number }) {
  const shown = agents.slice(0, max)
  return (
    <span className="inline-flex items-center">
      {shown.map((a, i) => (
        <span key={a.id} className="rounded-full bg-[var(--surface-solid)] ring-2 ring-[var(--surface-solid)]" style={{ marginLeft: i ? -size * 0.32 : 0, zIndex: max - i }}>
          <Sigil agent={a} size={size} />
        </span>
      ))}
    </span>
  )
}
