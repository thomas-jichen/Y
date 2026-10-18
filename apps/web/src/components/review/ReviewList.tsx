import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { ReviewItem, ReviewKind } from '@/api/types'
import { AgentArt } from '@/components/identity/AgentArt'
import { Tabs } from '@/components/primitives/Tabs'
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
    const unknown = i.kind === 'quarantined_message' || (i.kind === 'dm_request' && i.agent?.stranger)
    return (
      <Link key={i.id} to="/review/$id" params={{ id: i.id }} aria-current={active ? 'page' : undefined} className={cn('block px-3 py-3', active ? 'bg-fill [&_.text-text-2]:text-text' : 'hover:bg-fill/60', i.state !== 'pending' && !active && 'text-text-2')}>
        <span className="flex items-baseline justify-between gap-3 text-caption">
          <span className={cn(unknown ? 'font-semibold text-text' : 'text-text-2')}>
            {K.label}
            {unknown && ' · Unverified'}
          </span>
          <span className="shrink-0 text-text-2 tnum">
            {i.state === 'pending' ? i.expiresAt && `${fmtCountdown(i.expiresAt)} left` : i.state === 'approved' ? 'Approved' : 'Declined'}
          </span>
        </span>
        <span className="mt-1 block truncate text-ui font-medium">{i.summary}</span>
        <span className="mt-1 flex items-center gap-1.5 text-caption text-text-2">
          {i.agent && <AgentArt agent={i.agent} size={14} />}
          <span className="truncate">{i.agent?.displayName}</span>
          <span className="tnum">· {fmtAgo(i.createdAt)}</span>
        </span>
      </Link>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-6 pb-4 pt-8">
        <h1 className="display text-title">Review</h1>
        <p className="mt-1 text-ui text-text-2">Decisions only a human can make</p>
        <Tabs<Filter>
          size="sm"
          className="mt-6 gap-5"
          label="Filter"
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
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {pending.map(row)}
        {pending.length === 0 && <div className="px-3 py-8 text-ui text-text-2">You are all caught up.</div>}
        {done.length > 0 && <div className="px-3 pb-1 pt-6 text-caption text-text-2">Decided</div>}
        {done.map(row)}
      </div>
      <div className="hidden border-t border-rule px-6 py-3 text-caption text-text-2 md:block">
        <span className="font-mono">j</span> / <span className="font-mono">k</span> to move · focus the button and hold <span className="font-mono">space</span> to approve
      </div>
    </div>
  )
}
