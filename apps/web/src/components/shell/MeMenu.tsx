import * as Popover from '@radix-ui/react-popover'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { Me } from '@/api/types'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { PRESENCE } from '@/components/identity/PresenceDot'
import { HumanAvatar } from '@/components/primitives/HumanAvatar'
import { useActiveScroll, useSendForScroll, useTeam } from '@/api/queries'
import { auth } from '@/api/auth'
import { HttpError } from '@/api/client'
import { cn } from '@/lib/cn'
import { MOCKS } from '@/lib/env'
import { useThemePref, type ThemePref } from '@/lib/theme'
import { ui } from '@/lib/ui'

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/** The one place your agents are listed. Portaled, because glass traps fixed children. */
export function MeMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false)
  const { data: team } = useTeam()
  const { data: active } = useActiveScroll()
  const scroll = useSendForScroll()
  const nav = useNavigate()
  const [pref, setPref] = useThemePref()
  const astra = me.agents.find((a) => a.harness === 'astra') ?? me.agents[0]
  const beacon = (id: string) => team?.agents.find((c) => c.agent.id === id)?.beacon

  const sendToRead = async () => {
    if (!astra) return
    try {
      const r = await scroll.mutateAsync(astra.handle)
      setOpen(false)
      void nav({ to: '/scrolls/$id', params: { id: r.scrollId } })
    } catch (e) {
      if (e instanceof HttpError && e.code === 'REMOTE_INSTRUCTIONS_OFF') {
        setOpen(false)
        ui.set({ remoteSheet: true })
      }
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger aria-label={`${me.user.name}: your agents and settings`} className="ml-1 inline-flex size-9 items-center justify-center rounded-full">
        <HumanAvatar user={me.user} size={32} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={10} className="glass-pop z-50 w-[300px] rounded-glass p-2 text-ui data-[state=open]:animate-[fade-in_140ms_ease-out]">
          <div className="px-3 pb-3 pt-2">
            <div className="font-medium">{me.user.name}</div>
            <div className="font-mono text-caption">@{me.user.login}</div>
          </div>
          <div className="px-3 pb-1 text-caption">Your agents</div>
          {me.agents.map((a) => {
            const reading = active?.agent.id === a.id
            const b = beacon(a.id)
            const status = reading ? 'Reading the feed' : a.presence && a.presence !== 'away' && b ? `${PRESENCE[a.presence].label}: ${b.text}` : PRESENCE[a.presence ?? 'away'].label
            return (
              <Link
                key={a.id}
                to={reading ? '/scrolls/$id' : '/a/$handle'}
                params={reading ? { id: active.id } : { handle: a.handle }}
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 rounded-[10px] px-3 py-2 hover:bg-fill"
              >
                <AgentAvatar agent={a} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{a.displayName}</span>
                  <span className="block truncate text-caption">{status}</span>
                </span>
              </Link>
            )
          })}
          {/* Core has no scroll sessions yet, so real mode doesn't offer one. */}
          {MOCKS && !active && astra && (
            <button onClick={() => void sendToRead()} disabled={scroll.isPending} className="mx-3 mb-2 mt-1 text-left underline decoration-1 underline-offset-4 disabled:opacity-40">
              Send {astra.displayName} to read the feed
            </button>
          )}
          <div className="my-2 h-px bg-[var(--glass-edge)]" />
          <div className="flex items-center gap-3 px-3 py-2" role="radiogroup" aria-label="Theme">
            <span className="flex-1">Theme</span>
            {THEMES.map((t) => (
              <button
                key={t.value}
                role="radio"
                aria-checked={pref === t.value}
                onClick={() => setPref(t.value)}
                className={cn('underline-offset-4', pref === t.value ? 'font-medium underline decoration-1' : 'hover:underline')}
              >
                {t.label}
              </button>
            ))}
          </div>
          {!MOCKS && (
            <>
              <div className="my-2 h-px bg-[var(--glass-edge)]" />
              <button onClick={() => void auth.signOut()} className="w-full rounded-[10px] px-3 py-2 text-left hover:bg-fill">
                Sign out
              </button>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
