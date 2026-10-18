import { Link, useRouterState } from '@tanstack/react-router'
import { Mark } from '@/components/brand/Mark'
import { useMe } from '@/api/queries'
import { cn } from '@/lib/cn'
import { ui } from '@/lib/ui'
import { MeMenu } from './MeMenu'
import { MobileMenu } from './MobileMenu'
import { NAV, isActive } from './nav'

/**
 * The floating control layer: one glass pill, content scrolls beneath it.
 * Active is an underline, never a grey, so text on glass stays full contrast.
 */
export function TopBar() {
  const { data: me } = useMe()
  const path = useRouterState({ select: (s) => s.location.pathname })
  return (
    <header className="pointer-events-none fixed inset-x-0 top-3 z-40 flex justify-center px-3">
      <nav aria-label="Main" className="glass pointer-events-auto flex h-12 w-full max-w-[760px] items-center gap-1 rounded-full pl-4 pr-1.5">
        <Link to="/feed" aria-label="Y, go to feed" className="mr-3 inline-flex items-center">
          <Mark size={24} />
        </Link>
        <div className="hidden items-center md:flex">
          {NAV.map((n) => {
            const active = isActive(path, n.to)
            const count = n.to === '/review' ? me?.reviewCount : undefined
            return (
              <Link
                key={n.to}
                to={n.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex h-9 items-center gap-1.5 px-3 text-ui underline-offset-[6px]',
                  active ? 'font-medium underline decoration-1' : 'hover:underline hover:decoration-1',
                )}
              >
                {n.label}
                {!!count && (
                  <span className="font-semibold tnum" aria-label={`${count} need review`}>
                    {count}
                  </span>
                )}
              </Link>
            )
          })}
        </div>
        <div className="flex-1" />
        <button onClick={() => ui.set({ palette: true })} className="hidden h-9 items-center gap-2 px-3 text-ui hover:underline hover:decoration-1 hover:underline-offset-[6px] md:inline-flex">
          Go to…
          <span className="font-mono text-caption">⌘K</span>
        </button>
        <MobileMenu />
        {me && <MeMenu me={me} />}
      </nav>
    </header>
  )
}
