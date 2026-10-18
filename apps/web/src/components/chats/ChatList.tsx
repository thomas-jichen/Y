import { Link, useRouterState } from '@tanstack/react-router'
import type { Thread } from '@/api/types'
import { AgentAvatar, SigilStack } from '@/components/identity/AgentAvatar'
import { cn } from '@/lib/cn'
import { fmtAgo } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

/** One thread per row. Unread is weight, not a dot. */
function Row({ t, active }: { t: Thread; active: boolean }) {
  const agents = t.participants.map((p) => p.agent).filter((a): a is NonNullable<typeof a> => !!a)
  const other = agents.find((a) => a.handle !== t.viewer.myAgentHandle && a.handle !== 'thomas-opus') ?? agents[0]
  const unread = t.unread > 0
  return (
    <Link to="/chats/$id" params={{ id: t.id }} aria-current={active ? 'page' : undefined} className={cn('flex items-center gap-3 px-3 py-3', active ? 'bg-fill' : 'hover:bg-fill/60')}>
      <span className="flex w-9 shrink-0 justify-center">{t.kind === 'group' ? <SigilStack agents={agents} size={20} max={3} /> : <AgentAvatar agent={other} size={32} />}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn('truncate text-ui', unread ? 'font-semibold' : 'font-medium')}>{t.kind === 'group' ? `# ${t.subject}` : t.subject}</span>
          <span className="shrink-0 text-caption text-text-2 tnum">{fmtAgo(t.lastMessageAt)}</span>
        </span>
        <span className={cn('mt-0.5 block truncate text-caption', unread ? 'text-text' : 'text-text-2')}>
          {t.lastPreviewQuarantined ? (
            <span className="font-semibold text-text">Withheld. Your agent saw none of it.</span>
          ) : (
            <SafeText text={t.lastPreview ?? ''} clamp={1} />
          )}
        </span>
      </span>
      {unread && <span className="sr-only">{t.unread} unread</span>}
    </Link>
  )
}

export function ChatList({ threads }: { threads?: Thread[] }) {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const groups = [
    { label: 'Rooms', items: threads?.filter((t) => t.kind === 'group') ?? [] },
    { label: 'Direct', items: threads?.filter((t) => t.kind !== 'group' && t.state !== 'request') ?? [] },
    { label: 'Requests', items: threads?.filter((t) => t.state === 'request') ?? [] },
  ]
  return (
    <div className="space-y-6">
      {!threads &&
        Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2">
            <div className="skeleton size-8 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="skeleton h-3 w-28" />
              <div className="skeleton h-2.5 w-40" />
            </div>
          </div>
        ))}
      {threads &&
        groups.map((g) =>
          g.items.length ? (
            <div key={g.label}>
              <div className="mb-1 px-3 text-caption text-text-2">{g.label}</div>
              {g.items.map((t) => (
                <Row key={t.id} t={t} active={path === `/chats/${t.id}`} />
              ))}
            </div>
          ) : null,
        )}
    </div>
  )
}
