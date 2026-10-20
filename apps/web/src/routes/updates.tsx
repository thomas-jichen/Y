import { createFileRoute, Link } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo } from 'react'
import { useMe, useUpdates, useUpdatesSharing } from '@/api/queries'
import type { TurnUpdate, UpdatesSharing } from '@/api/types'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { AgentName } from '@/components/identity/AgentName'
import { Switch } from '@/components/primitives/Switch'
import { Page } from '@/components/shell/Page'
import { ScreenChip } from '@/components/trust/TrustBadge'
import { groupUpdates, type UpdateGroup as Group } from '@/components/updates/group'
import { fmtAgo, fmtClock } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

export const Route = createFileRoute('/updates')({ component: Updates })

/** One response: when, what changed, what it is building. Both lines are untrusted text. */
function UpdateRow({ u }: { u: TurnUpdate }) {
  return (
    <li className="grid grid-cols-[44px_1fr] gap-x-3 py-3 first:pt-0 last:pb-0">
      <time dateTime={u.createdAt} title={new Date(u.createdAt).toLocaleString()} className="pt-0.5 text-caption text-text-2 tnum">
        {fmtClock(u.createdAt)}
      </time>
      <dl className="min-w-0 space-y-1 text-body">
        <div>
          <dt className="inline font-medium">Changed: </dt>
          <dd className="inline">
            <SafeText text={u.changed} />
            {u.label && (
              <>
                {' '}
                <ScreenChip label={u.label} compact />
              </>
            )}
          </dd>
        </div>
        <div className="text-text-2">
          <dt className="inline font-medium text-text">Building: </dt>
          <dd className="inline">
            <SafeText text={u.building} />
          </dd>
        </div>
      </dl>
    </li>
  )
}

function UpdateGroup({ g, mine }: { g: Group; mine: boolean }) {
  const newest = g.items[0]
  return (
    <article className="grid grid-cols-[40px_1fr] gap-x-4">
      <Link to="/a/$handle" params={{ handle: g.agent.handle }} aria-label={g.agent.displayName} className="self-start">
        <AgentAvatar agent={g.agent} size={40} />
      </Link>
      <div className="min-w-0">
        <header className="flex h-6 items-center gap-2 text-ui">
          <AgentName agent={g.agent} className="shrink-0" />
          <span className="min-w-0 truncate text-text-2">
            <span className="hidden font-mono text-caption sm:inline">@{g.agent.handle} · </span>
            {mine ? 'Your agent' : g.agent.owner.name || g.agent.owner.login} · <span className="tnum">{fmtAgo(newest.createdAt)}</span>
          </span>
          <span className="flex-1" />
          {g.items.length > 1 && <span className="shrink-0 text-caption text-text-2 tnum">{g.items.length} responses</span>}
        </header>
        <ol className="mt-3 divide-y divide-rule">
          {g.items.map((u) => (
            <UpdateRow key={u.id} u={u} />
          ))}
        </ol>
      </div>
    </article>
  )
}

/** The viewer's own consent: their agents' updates stay private until they share them. */
function SharingRow({ sharing }: { sharing: UpdatesSharing }) {
  const set = useUpdatesSharing()
  const on = sharing.teamPolicyAccepted || (set.isPending ? set.variables === true : sharing.shareWithTeam)
  const note = sharing.teamPolicyAccepted
    ? 'You accepted your team’s policy, so your updates are shared with your team.'
    : on
      ? 'Teammates see what your agents changed and are building. Turning this off hides earlier updates from them too.'
      : 'Only you see your agents’ updates.'
  return (
    <label className="mb-10 flex items-center justify-between gap-6 border-y border-rule py-3 text-ui">
      <span>
        Share my agents’ updates with my team
        <span className="block text-caption text-text-2">{note}</span>
        {set.isError && (
          <span role="alert" className="block text-caption font-medium">
            Couldn’t save that. Try again.
          </span>
        )}
      </span>
      <Switch
        checked={on}
        disabled={sharing.teamPolicyAccepted || set.isPending}
        onCheckedChange={(v) => set.mutate(v)}
        label="Share my agents’ updates with my team"
      />
    </label>
  )
}

function Updates() {
  const { data, isPending, isError, hasNextPage, fetchNextPage, isFetchingNextPage } = useUpdates()
  const { data: me } = useMe()
  const myIds = useMemo(() => new Set(me?.agents.map((a) => a.id)), [me])
  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data])
  const groups = useMemo(() => groupUpdates(items), [items])
  const sharing = data?.pages[0]?.sharing

  return (
    <Page>
      <header className="mb-10">
        <h1 className="display text-headline">What agents are building</h1>
        <p className="mt-3 text-body text-text-2">A short note after every response from your team's agents: what changed, and where it is heading.</p>
      </header>

      {sharing && <SharingRow sharing={sharing} />}

      <div className="divide-y divide-rule">
        {isPending &&
          Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="grid grid-cols-[40px_1fr] gap-x-4 py-8">
              <div className="skeleton size-10 rounded-full" />
              <div className="space-y-3">
                <div className="skeleton h-4 w-1/3" />
                <div className="skeleton h-12" />
              </div>
            </div>
          ))}
        <AnimatePresence initial={false}>
          {groups.map((g) => (
            <motion.div key={g.key} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} className="py-8">
              <UpdateGroup g={g} mine={myIds.has(g.agent.id)} />
            </motion.div>
          ))}
        </AnimatePresence>
        {isError && items.length === 0 && (
          <div className="py-16">
            <div className="text-body font-medium">Couldn't load updates</div>
            <div className="mt-1 text-body text-text-2">Something went wrong on our side. Try again in a moment.</div>
          </div>
        )}
        {!isPending && !isError && items.length === 0 && (
          <div className="py-16">
            <div className="text-body font-medium">No updates yet</div>
            <div className="mt-1 text-body text-text-2">
              Updates appear here after each response from an agent with capture on.{' '}
              <Link to="/connect" className="underline decoration-1 underline-offset-4">
                Connect a machine
              </Link>{' '}
              to start. Agents that share stats only send no updates, and teammates' updates show up once they share them.
            </div>
          </div>
        )}
      </div>

      {hasNextPage && (
        <div className="pt-8">
          <button
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="text-ui underline decoration-1 underline-offset-4 disabled:opacity-40"
          >
            {isFetchingNextPage ? 'Loading' : 'Show older updates'}
          </button>
        </div>
      )}
    </Page>
  )
}
