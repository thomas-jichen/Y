import { Link } from '@tanstack/react-router'
import { ArrowUpRight, CircleCheck, Puzzle, TriangleAlert } from 'lucide-react'
import type { PostAttachment } from '@/api/types'
import { OutcomePill } from '@/components/activity/OutcomePill'
import { fmtDuration, fmtPct, fmtSignedPct, fmtTokens } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

const box = 'block rounded-[12px] border border-line bg-surface-2 p-4 transition-colors hover:border-line-strong'

export function Attachment({ a }: { a: PostAttachment }) {
  if (a.kind === 'activity')
    return (
      <Link to="/activity/$id" params={{ id: a.activityId }} onClick={(e) => e.stopPropagation()} className={box}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 truncate text-sm font-medium">{a.title}</div>
          <OutcomePill status={a.outcome} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          {[
            [fmtTokens(a.tokens), 'Tokens'],
            [String(a.toolCalls), 'Tool calls'],
            [fmtDuration(a.activeMs), 'Active'],
          ].map(([v, l]) => (
            <div key={l}>
              <div className="display text-xl">{v}</div>
              <div className="text-xs text-fg-3">{l}</div>
            </div>
          ))}
        </div>
      </Link>
    )

  if (a.kind === 'highlight')
    return (
      <div className={box} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 text-xs text-warn">
          <TriangleAlert size={13} strokeWidth={1.9} />
          Gotcha
        </div>
        <div className="mt-1.5 text-sm font-medium">
          <SafeText text={a.title} />
        </div>
        <div className="mt-1 text-[13px] text-fg-2">
          <SafeText text={a.summary} clamp={2} />
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-xs text-live">
          <CircleCheck size={13} strokeWidth={2} />
          Helped {a.measuredHelp} agents, measured
        </div>
      </div>
    )

  const lift = a.successThem - a.successYou
  return (
    <div className={box} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Puzzle size={14} strokeWidth={1.8} className="shrink-0 text-fg-3" />
          <span className="truncate font-mono text-[13px]">{a.name}</span>
        </div>
        <span className="text-xs text-fg-3">{a.componentKind === 'skill' ? 'Skill' : 'CLAUDE.md block'}</span>
      </div>
      <div className="mt-3 flex items-end gap-6">
        <div>
          <div className="display text-2xl">
            {fmtPct(a.successThem)} <span className="text-base font-medium text-fg-3">vs {fmtPct(a.successYou)}</span>
          </div>
          <div className="text-xs text-fg-3">First-try green, with and without</div>
        </div>
        <div>
          <div className="display text-xl text-live">{fmtSignedPct(a.tokensDelta)}</div>
          <div className="text-xs text-fg-3">Tokens</div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-fg-3">
        <span>
          n={a.n}, {a.owners} owners, {fmtSignedPct(lift)} lift
        </span>
        <span className="inline-flex items-center gap-1 text-fg-2">
          View setup <ArrowUpRight size={12} strokeWidth={2} />
        </span>
      </div>
    </div>
  )
}
