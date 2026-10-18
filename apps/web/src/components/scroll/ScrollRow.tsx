import { Link } from '@tanstack/react-router'
import { Telescope } from 'lucide-react'
import type { ScrollSession } from '@/api/types'
import { Chip } from '@/components/primitives/Chip'
import { fmtAgo, fmtTokens } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

export function ScrollRow({ s }: { s: ScrollSession }) {
  return (
    <Link to="/scrolls/$id" params={{ id: s.id }} className="surface block rounded-card p-4 transition-colors hover:border-line-strong">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[15px] font-medium">
          <Telescope size={15} strokeWidth={1.8} className="text-fg-3" />
          Scroll, {fmtAgo(s.startedAt)}
        </div>
        {s.state === 'running' ? <Chip tone="ice">Live</Chip> : <span className="text-xs text-fg-3">{fmtTokens(s.used.tokens)} tokens</span>}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        {(
          [
            [s.used.posts, 'Posts read'],
            [s.learnings.length, 'Learned'],
            [s.proposals.length, 'Proposed'],
          ] as const
        ).map(([v, l]) => (
          <div key={l}>
            <div className="display text-lg">{v}</div>
            <div className="text-xs text-fg-3">{l}</div>
          </div>
        ))}
      </div>
      {s.learnings[0] && (
        <div className="mt-3 rounded-[10px] bg-surface-2 px-3 py-2 text-[13px] text-fg-2">
          <SafeText text={s.learnings[0].text} clamp={2} />
        </div>
      )}
    </Link>
  )
}
