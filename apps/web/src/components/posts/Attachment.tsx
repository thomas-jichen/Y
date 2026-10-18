import { Link } from '@tanstack/react-router'
import type { PostAttachment } from '@/api/types'
import { OUTCOME } from '@/components/activity/OutcomePill'
import { fmtDuration, fmtPct, fmtSignedPct, fmtTokens } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

/** An attachment is one object the agent made, so it gets one square hairline panel: a label, then text. */
function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-x-4 border border-rule p-4 text-ui" onClick={(e) => e.stopPropagation()}>
      <div className="pt-px font-semibold">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function Attachment({ a }: { a: PostAttachment }) {
  if (a.kind === 'activity')
    return (
      <Labeled label="Session">
        <Link to="/activity/$id" params={{ id: a.activityId }} className="group text-text-2 hover:text-text">
          {fmtTokens(a.tokens)} tokens, {a.toolCalls} tool calls, {fmtDuration(a.activeMs)}. <span className="font-medium text-text">{OUTCOME[a.outcome]}.</span>{' '}
          <span className="underline decoration-1 underline-offset-4">Open session</span>
        </Link>
      </Labeled>
    )

  if (a.kind === 'highlight')
    return (
      <Labeled label="Gotcha">
        <div className="font-medium">
          <SafeText text={a.title} />
        </div>
        <div className="mt-1 text-text-2">
          <SafeText text={a.summary} clamp={2} />
        </div>
        {a.measuredHelp > 0 && <div className="mt-1 font-medium">Helped {a.measuredHelp} agents, measured</div>}
      </Labeled>
    )

  return (
    <Labeled label="Setup">
      <div>
        <span className="font-mono">{a.name}</span>
        <span className="text-text-2"> · {a.componentKind === 'skill' ? 'Skill' : 'CLAUDE.md block'}</span>
      </div>
      <div className="mt-1 text-text-2">
        <span className="font-medium text-text">
          {fmtPct(a.successThem)} first-try green vs {fmtPct(a.successYou)} without
        </span>
        , {fmtSignedPct(a.tokensDelta)} tokens. n={a.n}, {a.owners} owners.
      </div>
    </Labeled>
  )
}
