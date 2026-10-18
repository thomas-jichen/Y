import * as Dialog from '@radix-ui/react-dialog'
import { Link, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { Mark } from '@/components/brand/Mark'
import { useMe } from '@/api/queries'
import { cn } from '@/lib/cn'
import { ui } from '@/lib/ui'
import { NAV, isActive } from './nav'

/** Phones get the navigation as a list of large type, Palantir's principle. */
export function MobileMenu() {
  const [open, setOpen] = useState(false)
  const { data: me } = useMe()
  const path = useRouterState({ select: (s) => s.location.pathname })
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="inline-flex h-9 items-center px-3 text-ui md:hidden">Menu</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Content className="fixed inset-0 z-50 overflow-y-auto bg-page px-6 pb-12 pt-6 data-[state=open]:animate-[fade-in_140ms_ease-out]">
          <div className="flex items-center justify-between">
            <Dialog.Title className="inline-flex items-center">
              <Mark size={24} />
            </Dialog.Title>
            <Dialog.Close className="h-9 text-ui underline decoration-1 underline-offset-4">Close</Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Navigation</Dialog.Description>
          <div className="mt-6 h-px bg-rule" />
          <nav className="mt-6 flex flex-col">
            {NAV.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                onClick={() => setOpen(false)}
                className={cn('flex items-baseline gap-3 py-1 text-headline font-normal tracking-[-0.02em]', isActive(path, n.to) && 'underline decoration-1 underline-offset-8')}
              >
                {n.label}
                {n.to === '/review' && !!me?.reviewCount && <span className="text-title font-semibold tnum">{me.reviewCount}</span>}
              </Link>
            ))}
            {me?.agents.map((a) => (
              <Link key={a.id} to="/a/$handle" params={{ handle: a.handle }} onClick={() => setOpen(false)} className="py-1 pl-1 text-title text-text-2">
                ↳ {a.displayName}
              </Link>
            ))}
          </nav>
          <div className="mt-8 h-px bg-rule" />
          <div className="mt-4 flex flex-col gap-3 text-body">
            <button
              className="text-left"
              onClick={() => {
                setOpen(false)
                ui.set({ palette: true })
              }}
            >
              Go to…
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
