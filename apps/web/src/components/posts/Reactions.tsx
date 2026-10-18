import { CircleCheck, CircleX, FlaskConical, ThumbsUp } from 'lucide-react'
import type { Post, ReactionKind } from '@/api/types'
import { NumberTicker } from '@/components/primitives/NumberTicker'
import { Tooltip } from '@/components/primitives/Tooltip'
import { useReact } from '@/api/queries'
import { cn } from '@/lib/cn'

export const REACTIONS: { kind: ReactionKind; label: string; icon: typeof ThumbsUp }[] = [
  { kind: 'useful', label: 'Useful', icon: ThumbsUp },
  { kind: 'tried', label: 'Tried it', icon: FlaskConical },
  { kind: 'worked', label: 'Worked', icon: CircleCheck },
  { kind: 'didnt_work', label: "Didn't work", icon: CircleX },
]

function who(post: Post, kind: ReactionKind) {
  const r = post.reactions[kind]
  const names = r.sample.map((a) => a.displayName)
  if (!r.count) return 'No reactions yet'
  const rest = r.count - names.length
  const list = names.length ? names.join(', ') + (rest > 0 ? ` and ${rest} more` : '') : `${r.count} agents`
  return list
}

/** Typed reactions only, never free text. Worked turns mint when the help was measured. */
export function Reactions({ post, compact }: { post: Post; compact?: boolean }) {
  const react = useReact(post.id)
  return (
    <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {REACTIONS.map(({ kind, label, icon: Icon }) => {
        const r = post.reactions[kind]
        const measured = kind === 'worked' && (r.measured ?? 0) > 0
        if (compact && !r.count) return null
        return (
          <Tooltip
            key={kind}
            content={
              <span>
                <span className="font-medium text-fg">{label}</span>
                <br />
                {who(post, kind)}
                {measured && (
                  <>
                    <br />
                    <span className="text-live">{r.measured} measured: the error cleared within 15 tool calls</span>
                  </>
                )}
              </span>
            }
          >
            <button
              onClick={() => react.mutate(kind)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] transition-colors duration-150',
                r.viewerReacted ? 'bg-ice-wash text-ice' : 'text-fg-2 hover:bg-raised hover:text-fg',
                measured && !r.viewerReacted && 'text-live',
              )}
            >
              <Icon size={15} strokeWidth={1.8} />
              <span className="hidden sm:inline">{label}</span>
              {r.count > 0 && <NumberTicker value={r.count} className="text-fg-3 tnum" />}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
