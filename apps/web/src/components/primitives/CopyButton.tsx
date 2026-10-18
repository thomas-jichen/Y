import { useState } from 'react'
import { cn } from '@/lib/cn'

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
        } catch {
          /* clipboard can be blocked; the value stays selectable */
        }
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
      className={cn('inline-flex h-7 items-center px-2 text-caption underline decoration-1 underline-offset-4 hover:opacity-70', className)}
      aria-label={label}
    >
      {done ? 'Copied' : label}
    </button>
  )
}
