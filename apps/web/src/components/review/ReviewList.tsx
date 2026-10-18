import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { Slack } from './SlackIcon'
import { useEffect, useState } from 'react'
import type { ReviewItem, ReviewKind } from '@/api/types'
import { Sigil } from '@/components/identity/Sigil'
import { Kbd } from '@/components/primitives/Kbd'
import { Segmented } from '@/components/primitives/Segmented'
import { cn } from '@/lib/cn'
import { fmtAgo, fmtCountdown } from '@/lib/format'
import { REVIEW_KIND } from './kinds'

type Filter = 'all' | 'draft' | 'change_request' | 'requests'
const match = (f: Filter, k: ReviewKind) => f === 'all' || (f === 'requests' ? k === 'dm_request' || k === 'quarantined_message' : k === f)

export function ReviewList({ items }: { items?: ReviewItem[] }) {
  const [filter, setFilter] = useState<Filter>('all')
  const path = useRouterState({ select: (s) => s.location.pathname })
  const nav = useNavigate()
  const shown = (items ?? []).filter((i) => match(filter, i.kind))
  const pending = shown.filter((i) => i.state === 'pending')
  const done = shown.filter((i) => i.state !== 'pending')
  const order = [...pending, ...done]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && ['INPUT', 'TEXTAREA'].includes(t.tagName)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const idx = order.findIndex((i) => path === `/review/${i.id}`)
      if (e.key === 'j' || e.key === 'k') {
        const next = order[Math.max(0, Math.min(order.length - 1, idx + (e.key === 'j' ? 1 : -1)))]
        if (next) void nav({ to: '/review/$id', params: { id: next.id } })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [order, path, nav])

  const row = (i: ReviewItem) => {
    const K = REVIEW_KIND[i.kind]
    const active = path === `/review/${i.id}`
    return (
      <Link
        key={i.id}
        to="/review/$id"
        params={{ id: i.id }}
        className={cn('flex items-start gap-3 rounded-[12px] px-2.5 py-2.5 transition-colors', active ? 'bg-raised shadow-[inset_0_1px_0_var(--specular)]' : 'hover:bg-surface-2', i.state !== 'pending' && 'opacity-60')}
      >
        <span className={cn('mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-[9px]', i.kind === 'quarantined_message' || (i.kind === 'dm_request' && i.agent?.stranger) ? 'bg-fail/12 text-fail' : 'bg-raised text-fg-2')}>
          <K.icon size={15} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{i.summary}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-3">
            {i.agent && <Sigil agent={i.agent} size={14} />}
            <span className="truncate">{i.agent?.displayName}</span>
            <span className="tnum">{fmtAgo(i.createdAt)}</span>
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 text-2xs text-fg-3">
          {i.state === 'pending' ? i.expiresAt && <span className="tnum">{fmtCountdown(i.expiresAt)} left</span> : <span>{i.state === 'approved' ? 'Approved' : 'Declined'}</span>}
          {i.slackSent && i.state === 'pending' && <Slack />}
        </span>
      </Link>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pb-3 pt-4">
        <h1 className="display text-xl">Review</h1>
        <p className="mt-0.5 text-xs text-fg-3">Decisions only a human can make</p>
        <Segmented<Filter>
          size="sm"
          stretch
          className="mt-3"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: items?.filter((i) => i.state === 'pending').length },
            { value: 'draft', label: 'Drafts' },
            { value: 'change_request', label: 'Changes' },
            { value: 'requests', label: 'Requests' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {pending.map(row)}
        {pending.length === 0 && <div className="px-3 py-8 text-center text-sm text-fg-3">You are all caught up.</div>}
        {done.length > 0 && <div className="px-2.5 pb-1 pt-4 text-xs text-fg-3">Decided</div>}
        {done.map(row)}
      </div>
      <div className="hidden items-center gap-3 border-t border-line px-4 py-2.5 text-2xs text-fg-3 md:flex">
        <span className="flex items-center gap-1">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          Hold <Kbd>space</Kbd> to approve
        </span>
      </div>
    </div>
  )
}
