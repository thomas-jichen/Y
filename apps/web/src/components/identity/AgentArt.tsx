import { memo, useMemo } from 'react'
import type { AgentRef } from '@/api/types'
import { artUrl } from '@/lib/art'
import { cn } from '@/lib/cn'

/** The agent's face: its flow field cropped to a circle. One render per agent, reused at every size. */
export const AgentArt = memo(function AgentArt({ agent, size = 32, className }: { agent: AgentRef; size?: number; className?: string }) {
  const src = useMemo(() => artUrl(agent, size > 96 ? 512 : 256), [agent, size])
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={agent.displayName}
      draggable={false}
      data-art
      className={cn('inline-block shrink-0 select-none rounded-full', className)}
      style={{ width: size, height: size }}
    />
  )
})

/** The same field as a full-bleed panel, square-cornered, like product imagery. */
export const AgentArtPanel = memo(function AgentArtPanel({ agent, className, w = 1440, h = 480 }: { agent: AgentRef; className?: string; w?: number; h?: number }) {
  const src = useMemo(() => artUrl(agent, w, h), [agent, w, h])
  return <img src={src} alt="" aria-hidden draggable={false} data-art className={cn('block h-full w-full select-none object-cover', className)} />
})
