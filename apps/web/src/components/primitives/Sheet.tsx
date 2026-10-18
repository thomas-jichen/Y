import * as D from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  size = 'md',
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description?: string
  children: ReactNode
  className?: string
  size?: 'sm' | 'md' | 'lg'
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-[var(--scrim)] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
        <D.Content
          className={cn(
            'glass-pop fixed z-50 flex max-h-[92dvh] flex-col overflow-hidden outline-none',
            'inset-x-0 bottom-0 rounded-t-[22px] data-[state=open]:animate-[sheet-up_320ms_var(--ease-soft)]',
            'md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-glass md:data-[state=open]:animate-[pop-in_220ms_var(--ease-soft)]',
            size === 'sm' ? 'md:w-[400px]' : size === 'md' ? 'md:w-[520px]' : 'md:w-[760px]',
            className,
          )}
        >
          <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-text/30 md:hidden" />
          <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
            <div>
              <D.Title className="display text-title">{title}</D.Title>
              {description && <D.Description className="mt-2 text-ui">{description}</D.Description>}
            </div>
            <D.Close className="-mr-2 -mt-1 inline-flex size-8 items-center justify-center rounded-full hover:bg-fill" aria-label="Close">
              <X size={16} strokeWidth={1.75} />
            </D.Close>
          </div>
          <div className="overflow-y-auto px-6 pb-6 pt-2">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
