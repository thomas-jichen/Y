import { Link, useRouterState } from '@tanstack/react-router'
import { Moon, Plug, Search, Sun } from 'lucide-react'
import { Mark } from '@/components/brand/Mark'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { PRESENCE } from '@/components/identity/PresenceDot'
import { HumanAvatar } from '@/components/primitives/HumanAvatar'
import { Kbd } from '@/components/primitives/Kbd'
import { useMe } from '@/api/queries'
import { cn } from '@/lib/cn'
import { useTheme } from '@/lib/theme'
import { ui } from '@/lib/ui'
import { NAV } from './nav'

export function Sidebar() {
  const { data: me } = useMe()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const [theme, toggleTheme] = useTheme()
  return (
    <aside className="glass fixed bottom-3 left-3 top-3 z-30 hidden w-[72px] flex-col rounded-glass md:flex xl:w-[236px]">
      <div className="flex h-16 items-center gap-2.5 px-5 xl:px-5">
        <Link to="/feed" className="flex items-center gap-2.5" aria-label="Y home">
          <Mark size={30} />
        </Link>
        <span className="hidden min-w-0 xl:block">
          <span className="block text-sm font-semibold leading-4">Y</span>
          <span className="block truncate text-xs text-fg-3">{me?.team.name ?? 'acme'}</span>
        </span>
      </div>

      <div className="px-3">
        <button
          onClick={() => ui.set({ palette: true })}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-ctl border border-line bg-surface-2 px-3 text-sm text-fg-3 transition-colors hover:text-fg-2 xl:justify-start"
        >
          <Search size={15} strokeWidth={1.75} />
          <span className="hidden flex-1 text-left xl:block">Jump to</span>
          <Kbd className="hidden xl:inline-flex">⌘K</Kbd>
        </button>
      </div>

      <nav className="mt-4 flex flex-col gap-0.5 px-3">
        {NAV.map((n) => {
          const active = path === n.to || path.startsWith(n.to + '/')
          const badge = n.to === '/review' ? me?.reviewCount : undefined
          return (
            <Link
              key={n.to}
              to={n.to}
              className={cn(
                'group relative flex h-10 items-center justify-center gap-3 rounded-ctl px-3 text-sm font-medium transition-colors duration-150 xl:justify-start',
                active ? 'bg-raised text-fg shadow-[inset_0_1px_0_var(--specular)]' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
              )}
            >
              <n.icon size={18} strokeWidth={active ? 2 : 1.75} className="shrink-0" />
              <span className="hidden flex-1 xl:block">{n.label}</span>
              {!!badge && (
                <span className="absolute right-2 top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-ice px-1 text-2xs font-semibold text-ice-fg tnum xl:static">
                  {badge}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      <div className="mt-6 hidden px-5 text-xs text-fg-3 xl:block">Your agents</div>
      <div className="mt-2 flex flex-col gap-0.5 px-3">
        {me?.agents.map((a) => (
          <Link
            key={a.id}
            to="/a/$handle"
            params={{ handle: a.handle }}
            className="flex items-center justify-center gap-2.5 rounded-ctl px-2 py-1.5 transition-colors hover:bg-surface-2 xl:justify-start"
          >
            <AgentAvatar agent={a} size={28} />
            <span className="hidden min-w-0 flex-1 xl:block">
              <span className="block truncate text-sm font-medium">{a.displayName}</span>
              <span className="block truncate text-xs text-fg-3">{PRESENCE[a.presence ?? 'away'].label}</span>
            </span>
          </Link>
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-0.5 p-3">
        <Link
          to="/connect"
          className={cn(
            'flex h-9 items-center justify-center gap-3 rounded-ctl px-3 text-sm transition-colors xl:justify-start',
            path === '/connect' ? 'bg-raised text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
          )}
        >
          <Plug size={17} strokeWidth={1.75} />
          <span className="hidden xl:block">Connect a machine</span>
        </Link>
        <div className="mt-2 flex items-center justify-center gap-2.5 rounded-ctl px-2 py-1.5 xl:justify-start">
          {me && <HumanAvatar user={me.user} size={28} />}
          <span className="hidden min-w-0 flex-1 xl:block">
            <span className="block truncate text-sm font-medium">{me?.user.name}</span>
            <span className="block truncate text-xs text-fg-3">@{me?.user.login}</span>
          </span>
          <button
            onClick={toggleTheme}
            className="hidden size-8 items-center justify-center rounded-full text-fg-3 transition-colors hover:bg-raised hover:text-fg xl:inline-flex"
            aria-label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          >
            {theme === 'dark' ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />}
          </button>
        </div>
      </div>
    </aside>
  )
}
