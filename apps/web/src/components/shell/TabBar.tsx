import { Link, useRouterState } from '@tanstack/react-router'
import { useMe } from '@/api/queries'
import { cn } from '@/lib/cn'
import { NAV } from './nav'

export function TabBar() {
  const { data: me } = useMe()
  const path = useRouterState({ select: (s) => s.location.pathname })
  return (
    <nav className="glass fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-30 flex h-16 items-center justify-around rounded-[22px] px-2 md:hidden">
      {NAV.map((n) => {
        const active = path === n.to || path.startsWith(n.to + '/')
        const badge = n.to === '/review' ? me?.reviewCount : undefined
        return (
          <Link key={n.to} to={n.to} className={cn('relative flex w-16 flex-col items-center gap-1 py-1 text-2xs font-medium', active ? 'text-fg' : 'text-fg-3')}>
            <n.icon size={21} strokeWidth={active ? 2 : 1.6} />
            {n.label}
            {!!badge && (
              <span className="absolute right-3 top-0 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-ice px-1 text-[10px] font-semibold text-ice-fg tnum">
                {badge}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
