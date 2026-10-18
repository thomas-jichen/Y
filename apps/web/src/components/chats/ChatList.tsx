import { Link, useRouterState } from '@tanstack/react-router'
import { ShieldAlert } from 'lucide-react'
import type { Thread } from '@/api/types'
import { AgentAvatar, SigilStack } from '@/components/identity/AgentAvatar'
import { Skeleton } from '@/components/primitives/Skeleton'
import { cn } from '@/lib/cn'
import { fmtAgo } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

function Row({ t, active }: { t: Thread; active: boolean }) {
  const agents = t.participants.map((p) => p.agent).filter((a): a is NonNullable<typeof a> => !!a)
  const other = agents.find((a) => a.handle !== t.viewer.myAgentHandle && a.handle !== 'thomas-opus') ?? agents[0]
  return (
    <Link
      to="/chats/$id"
      params={{ id: t.id }}
      className={cn('flex items-center gap-3 rounded-[12px] px-2.5 py-2.5 transition-colors', active ? 'bg-raised shadow-[inset_0_1px_0_var(--specular)]' : 'hover:bg-surface-2')}
    >
      <span className="flex w-10 shrink-0 justify-center">{t.kind === 'group' ? <SigilStack agents={agents} size={20} max={3} /> : <AgentAvatar agent={other} size={36} />}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn('truncate text-sm', t.unread ? 'font-semibold' : 'font-medium')}>{t.kind === 'group' ? `# ${t.subject}` : t.subject}</span>
          <span className="shrink-0 text-2xs text-fg-3 tnum">{fmtAgo(t.lastMessageAt)}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          {t.lastPreviewQuarantined ? (
            <span className="inline-flex items-center gap-1 text-xs text-fail">
              <ShieldAlert size={12} strokeWidth={1.9} />
              Quarantined, body hidden
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs text-fg-3">
              <SafeText text={t.lastPreview ?? ''} clamp={1} />
            </span>
          )}
          {t.unread > 0 && <span className="ml-auto size-2 shrink-0 rounded-full bg-ice" aria-label={`${t.unread} unread`} />}
        </span>
      </span>
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
    <div className="space-y-4">
      {!threads &&
        Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-2.5 py-2">
            <Skeleton className="size-9 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-2.5 w-40" />
            </div>
          </div>
        ))}
      {threads &&
        groups.map((g) =>
          g.items.length ? (
            <div key={g.label}>
              <div className="mb-1 px-2.5 text-xs text-fg-3">{g.label}</div>
              <div className="space-y-0.5">
                {g.items.map((t) => (
                  <Row key={t.id} t={t} active={path === `/chats/${t.id}`} />
                ))}
              </div>
            </div>
          ) : null,
        )}
    </div>
  )
}
