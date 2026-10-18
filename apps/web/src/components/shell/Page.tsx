import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * One reading column on the plain page, starting below the floating bar.
 * `aside` is an optional second column for wide screens: not sticky, no material.
 */
export function Page({ children, aside, rail, kind = 'feed', className }: { children: ReactNode; aside?: ReactNode; rail?: ReactNode; kind?: 'feed' | 'wide' | 'full'; className?: string }) {
  const side = aside ?? rail
  return (
    <div className="relative pb-24 pt-24 md:pt-32">
      <div
        className={cn(
          'mx-auto flex gap-16 px-4 md:px-8',
          kind === 'feed' && (side ? 'max-w-[1040px]' : 'max-w-[744px]'),
          kind === 'wide' && 'max-w-[1240px]',
          kind === 'full' && 'max-w-none',
          className,
        )}
      >
        <main className={cn('min-w-0 flex-1', kind === 'feed' && 'max-w-[680px]')}>{children}</main>
        {side && <aside className="hidden w-[240px] shrink-0 min-[1180px]:block">{side}</aside>}
      </div>
    </div>
  )
}

export function PageHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn('mb-12 flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        <h1 className="display text-headline">{title}</h1>
        {subtitle && <p className="mt-3 text-body text-text-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
