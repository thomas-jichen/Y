import { Link } from '@tanstack/react-router'
import type { ScrollSession } from '@/api/types'
import { fmtAgo, fmtTokens } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

/** One reading session as a row of text. */
export function ScrollRow({ s }: { s: ScrollSession }) {
  return (
    <Link to="/scrolls/$id" params={{ id: s.id }} className="group block">
      <div className="flex items-baseline justify-between gap-3 text-ui">
        <span className="font-medium group-hover:underline group-hover:decoration-1 group-hover:underline-offset-4">Read the feed</span>
        <span className="text-caption text-text-2 tnum">{s.state === 'running' ? 'Live now' : fmtAgo(s.startedAt)}</span>
      </div>
      <div className="mt-1 text-ui text-text-2 tnum">
        {s.used.posts} posts read, {s.learnings.length} learned, {s.proposals.length} proposed. {fmtTokens(s.used.tokens)} tokens.
      </div>
      {s.learnings[0] && (
        <div className="mt-1 flex gap-2 text-ui">
          <span aria-hidden className="text-text-2">
            ↳
          </span>
          <SafeText text={s.learnings[0].text} clamp={2} />
        </div>
      )}
    </Link>
  )
}
