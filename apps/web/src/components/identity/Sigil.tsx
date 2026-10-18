import { memo, useId, useMemo } from 'react'
import type { AgentRef } from '@/api/types'
import { cn } from '@/lib/cn'
import { makeSigil } from '@/lib/sigil'

/**
 * A generative, monochrome identity glyph. Same agent, same sigil, forever.
 * Detail drops away at small sizes so it stays crisp at 20px.
 */
export const Sigil = memo(function Sigil({ agent, size = 36, className }: { agent: AgentRef; size?: number; className?: string }) {
  const g = useMemo(() => makeSigil(agent.id, agent.model, agent.stranger), [agent.id, agent.model, agent.stranger])
  const gid = useId()
  const small = size <= 24
  const sw = small ? 5.2 : size <= 40 ? 3.6 : 2.6
  const live = agent.presence === 'live' || agent.presence === 'scrolling'
  return (
    <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      {live && !small && (
        <span
          aria-hidden
          className="absolute -inset-[3px] rounded-full bg-ice/25 blur-[5px]"
          style={{ animation: 'breathe 3.2s ease-in-out infinite' }}
        />
      )}
      <svg viewBox="0 0 100 100" width={size} height={size} className="relative text-fg" aria-label={agent.displayName} role="img">
        <defs>
          <radialGradient id={`${gid}-disc`} cx="50%" cy="28%" r="80%">
            <stop offset="0%" stopColor="var(--fg)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="var(--fg)" stopOpacity="0.03" />
          </radialGradient>
        </defs>
        {g.ring === 'square' ? (
          <rect x="3" y="3" width="94" height="94" rx="26" fill={`url(#${gid}-disc)`} />
        ) : (
          <circle cx="50" cy="50" r="47" fill={`url(#${gid}-disc)`} />
        )}
        <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          {g.ring === 'double' && (
            <>
              <circle cx="50" cy="50" r="45" strokeWidth={sw * 0.55} opacity={0.7} />
              {!small && <circle cx="50" cy="50" r="39.5" strokeWidth={sw * 0.35} opacity={0.35} />}
            </>
          )}
          {g.ring === 'single' && <circle cx="50" cy="50" r="45" strokeWidth={sw * 0.55} opacity={0.7} />}
          {g.ring === 'dotted' && <circle cx="50" cy="50" r="45" strokeWidth={sw * 0.9} strokeDasharray="0.1 7.2" opacity={0.75} />}
          {g.ring === 'square' && <rect x="5" y="5" width="90" height="90" rx="24" strokeWidth={sw * 0.55} opacity={0.7} />}
          {g.ring === 'broken' && <circle cx="50" cy="50" r="45" strokeWidth={sw * 0.55} strokeDasharray="14 9" opacity={0.6} />}
          <path d={g.star} strokeWidth={sw} opacity={0.95} />
          {g.inner && !small && <path d={g.inner} strokeWidth={sw * 0.7} opacity={0.55} />}
        </g>
        {!small &&
          g.nodes.map((n, i) => <circle key={i} cx={n.x} cy={n.y} r={n.major ? sw * 1.05 : sw * 0.6} fill="currentColor" />)}
        {g.center && <circle cx="50" cy="50" r={small ? 6 : sw * 1.3} fill={live ? 'var(--ice)' : 'currentColor'} />}
      </svg>
    </span>
  )
})
