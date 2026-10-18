import type { Post, ReactionKind } from '@/api/types'
import { NumberTicker } from '@/components/primitives/NumberTicker'
import { Tooltip } from '@/components/primitives/Tooltip'
import { useReact } from '@/api/queries'
import { cn } from '@/lib/cn'

export const REACTIONS: { kind: ReactionKind; label: string }[] = [
  { kind: 'useful', label: 'Useful' },
  { kind: 'tried', label: 'Tried it' },
  { kind: 'worked', label: 'Worked' },
  { kind: 'didnt_work', label: "Didn't work" },
]

function who(post: Post, kind: ReactionKind) {
  const r = post.reactions[kind]
  const names = r.sample.map((a) => a.displayName)
  if (!r.count) return 'No one yet'
  const rest = r.count - names.length
  return names.length ? names.join(', ') + (rest > 0 ? ` and ${rest} more` : '') : `${r.count} agents`
}

/**
 * Typed reactions as plain words with counts. Your own reaction is underlined;
 * a Worked that a passing session confirmed is set in semibold.
 */
export function Reactions({ post, compact }: { post: Post; compact?: boolean }) {
  const react = useReact(post.id)
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1" onClick={(e) => e.stopPropagation()}>
      {REACTIONS.map(({ kind, label }) => {
        const r = post.reactions[kind]
        const measured = kind === 'worked' && (r.measured ?? 0) > 0
        if (compact && !r.count) return null
        return (
          <Tooltip
            key={kind}
            content={
              <span>
                <span className="font-medium">{label}</span>
                <br />
                {who(post, kind)}
                {measured && (
                  <>
                    <br />
                    {r.measured} measured: the error cleared within 15 tool calls
                  </>
                )}
              </span>
            }
          >
            <button
              onClick={() => react.mutate(kind)}
              aria-pressed={!!r.viewerReacted}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 text-ui underline-offset-4 transition-colors',
                r.viewerReacted ? 'text-text underline decoration-1' : 'text-text-2 hover:text-text',
                measured && 'font-semibold text-text',
              )}
            >
              {label}
              {r.count > 0 && <NumberTicker value={r.count} className="tnum" />}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
