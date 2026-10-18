import { Command } from 'cmdk'
import { useNavigate } from '@tanstack/react-router'
import { Moon, Plug, Search, Sparkles, Telescope } from 'lucide-react'
import { useEffect } from 'react'
import { Sigil } from '@/components/identity/Sigil'
import { useMe, useSendForScroll, useTeam } from '@/api/queries'
import { HttpError } from '@/api/client'
import { useTheme } from '@/lib/theme'
import { ui, useUI } from '@/lib/ui'
import { MOCKS } from '@/mocks/enabled'
import { NAV } from './nav'

const item =
  'flex h-10 cursor-pointer items-center gap-3 rounded-[10px] px-3 text-sm text-fg-2 data-[selected=true]:bg-raised data-[selected=true]:text-fg'
const group = 'px-2 pb-1 pt-3 text-xs text-fg-3 [&_[cmdk-group-heading]]:px-1 [&_[cmdk-group-heading]]:pb-1.5'

export function CommandPalette() {
  const { palette } = useUI()
  const nav = useNavigate()
  const { data: team } = useTeam()
  const { data: me } = useMe()
  const [, toggleTheme] = useTheme()
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
      label="Jump to"
      overlayClassName="fixed inset-0 z-50 bg-[var(--scrim)] backdrop-blur-[4px]"
      contentClassName="glass-pop fixed left-1/2 top-[14vh] z-50 w-[min(600px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-glass data-[state=open]:animate-[pop-in_200ms_var(--ease-soft)]"
    >
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search size={16} strokeWidth={1.75} className="text-fg-3" />
        <Command.Input placeholder="Jump to a page, agent or action" className="h-14 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-3" />
      </div>
      <Command.List className="max-h-[52vh] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-8 text-center text-sm text-fg-3">Nothing matches.</Command.Empty>
        <Command.Group heading="Go to" className={group}>
          {NAV.map((n) => (
            <Command.Item key={n.to} value={`go ${n.label}`} onSelect={() => go(n.to)} className={item}>
              <n.icon size={16} strokeWidth={1.75} />
              {n.label}
              <span className="ml-auto font-mono text-2xs text-fg-3">g {n.key}</span>
            </Command.Item>
          ))}
          <Command.Item value="go connect machine" onSelect={() => go('/connect')} className={item}>
            <Plug size={16} strokeWidth={1.75} />
            Connect a machine
          </Command.Item>
        </Command.Group>
        <Command.Group heading="Agents" className={group}>
          {team?.agents.map((c) => (
            <Command.Item key={c.agent.id} value={`agent ${c.agent.displayName} ${c.agent.handle}`} onSelect={() => go('/a/$handle', { handle: c.agent.handle })} className={item}>
              <Sigil agent={c.agent} size={20} />
              {c.agent.displayName}
              <span className="ml-auto font-mono text-2xs text-fg-3">@{c.agent.handle}</span>
            </Command.Item>
          ))}
        </Command.Group>
        <Command.Group heading="Actions" className={group}>
          {me?.agents
            .filter((a) => a.harness === 'codex')
            .map((a) => (
              <Command.Item
                key={a.id}
                value={`scroll ${a.displayName}`}
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
                <Telescope size={16} strokeWidth={1.75} />
                Send {a.displayName} for a scroll
              </Command.Item>
            ))}
          <Command.Item value="toggle theme light dark" onSelect={() => (toggleTheme(), close())} className={item}>
            <Moon size={16} strokeWidth={1.75} />
            Toggle light and dark
          </Command.Item>
          {MOCKS && (
            <Command.Item value="demo director" onSelect={() => ui.set({ palette: false, director: true })} className={item}>
              <Sparkles size={16} strokeWidth={1.75} />
              Open demo director
              <span className="ml-auto font-mono text-2xs text-fg-3">`</span>
            </Command.Item>
          )}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  )
}
