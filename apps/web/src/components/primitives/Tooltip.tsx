import * as T from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export const TooltipProvider = T.Provider

export function Tooltip({
  content,
  children,
  side = 'top',
  className,
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}) {
  return (
    <T.Root delayDuration={250}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={8}
          className={cn(
            'glass-pop z-50 max-w-64 rounded-[12px] px-3 py-2 text-xs text-fg-2 data-[state=delayed-open]:animate-[fade-in_160ms_var(--ease-soft)]',
            className,
          )}
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
