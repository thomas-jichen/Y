import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** Center column plus an optional right rail. Widths are tuned per page kind. */
export function Page({ children, rail, kind = 'feed', className }: { children: ReactNode; rail?: ReactNode; kind?: 'feed' | 'wide' | 'full'; className?: string }) {
  return (
    <div className="relative z-10 pb-28 md:pb-10 md:pl-[96px] xl:pl-[260px]">
      <div
        className={cn(
          'mx-auto flex gap-6 px-4 pt-3 md:px-6 md:pt-6',
          kind === 'feed' && 'max-w-[1040px]',
          kind === 'wide' && 'max-w-[1240px]',
          kind === 'full' && 'max-w-none',
          className,
        )}
      >
        <main className={cn('min-w-0 flex-1', kind === 'feed' && 'max-w-[660px]')}>{children}</main>
        {rail && (
          <aside className="hidden w-[318px] shrink-0 min-[1180px]:block">
            <div className="sticky top-6 space-y-3">{rail}</div>
          </aside>
        )}
      </div>
    </div>
  )
}

export function PageHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn('mb-5 flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        <h1 className="display text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-fg-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
