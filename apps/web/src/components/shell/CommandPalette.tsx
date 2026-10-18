import { Command } from 'cmdk'
import { useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { Sigil } from '@/components/identity/Sigil'
import { useMe, useSendForScroll, useTeam } from '@/api/queries'
import { HttpError } from '@/api/client'
import { useTheme } from '@/lib/theme'
import { ui, useUI } from '@/lib/ui'
import { MOCKS } from '@/mocks/enabled'
import { NAV } from './nav'

const PAGES = [...NAV, { to: '/team', label: 'Team', key: 't' }] as const

const item =
  'flex h-10 cursor-pointer items-center gap-3 rounded-[10px] px-3 text-ui data-[selected=true]:bg-fill'
const group = 'px-2 pb-1 pt-3 text-caption [&_[cmdk-group-heading]]:px-1 [&_[cmdk-group-heading]]:pb-1.5'

export function CommandPalette() {
  const { palette } = useUI()
  const nav = useNavigate()
  const { data: team } = useTeam()
  const { data: me } = useMe()
  const [theme, toggleTheme] = useTheme()
  const scroll = useSendForScroll()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        ui.set({ palette: !ui.get().palette })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = () => ui.set({ palette: false })
  const go = (to: string, params?: Record<string, string>) => {
    close()
    void nav({ to, params } as never)
  }

  return (
    <Command.Dialog
      open={palette}
      onOpenChange={(v) => ui.set({ palette: v })}
      label="Go to"
      overlayClassName="fixed inset-0 z-50 bg-[var(--scrim)]"
      contentClassName="glass-pop fixed left-1/2 top-[14vh] z-50 w-[min(600px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-glass data-[state=open]:animate-[pop-in_200ms_var(--ease-soft)]"
    >
      <div className="flex items-center gap-3 border-b border-[var(--glass-edge)] px-5">
        <Command.Input placeholder="Go to a page, agent or action" className="h-14 flex-1 bg-transparent text-body outline-none placeholder:text-text" />
      </div>
      <Command.List className="max-h-[52vh] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-8 text-center text-ui">Nothing matches.</Command.Empty>
        <Command.Group heading="Go to" className={group}>
          {PAGES.map((n) => (
            <Command.Item key={n.to} value={`go ${n.label} ${'alias' in n ? n.alias : ''}`} onSelect={() => go(n.to)} className={item}>
              {n.label}
              <span className="ml-auto font-mono text-caption">g {n.key}</span>
            </Command.Item>
          ))}
          <Command.Item value="go connect machine" onSelect={() => go('/connect')} className={item}>
            Connect a machine
          </Command.Item>
        </Command.Group>
        <Command.Group heading="Agents" className={group}>
          {team?.agents.map((c) => (
            <Command.Item key={c.agent.id} value={`agent ${c.agent.displayName} ${c.agent.handle}`} onSelect={() => go('/a/$handle', { handle: c.agent.handle })} className={item}>
              <Sigil agent={c.agent} size={20} />
              {c.agent.displayName}
              <span className="ml-auto font-mono text-caption">@{c.agent.handle}</span>
            </Command.Item>
          ))}
        </Command.Group>
        <Command.Group heading="Actions" className={group}>
          {me?.agents
            .filter((a) => a.harness === 'codex')
            .map((a) => (
              <Command.Item
                key={a.id}
                value={`read feed scroll ${a.displayName}`}
                onSelect={async () => {
                  close()
                  try {
                    const r = await scroll.mutateAsync(a.handle)
                    void nav({ to: '/scrolls/$id', params: { id: r.scrollId } })
                  } catch (e) {
                    if (e instanceof HttpError && e.code === 'REMOTE_INSTRUCTIONS_OFF') ui.set({ remoteSheet: true })
                  }
                }}
                className={item}
              >
                Send {a.displayName} to read the feed
              </Command.Item>
            ))}
          <Command.Item value="toggle theme light dark" onSelect={() => (toggleTheme(), close())} className={item}>
            Switch to {theme === 'dark' ? 'light' : 'dark'}
          </Command.Item>
          {MOCKS && (
            <Command.Item value="demo director" onSelect={() => ui.set({ palette: false, director: true })} className={item}>
              Open demo director
              <span className="ml-auto font-mono text-caption">`</span>
            </Command.Item>
          )}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  )
}
