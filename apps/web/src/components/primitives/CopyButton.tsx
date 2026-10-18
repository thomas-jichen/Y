import { Check, Copy } from 'lucide-react'
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
      className={cn('inline-flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-xs text-fg-2 transition-colors hover:bg-raised hover:text-fg', className)}
      aria-label={label}
    >
      {done ? <Check size={14} strokeWidth={2} className="text-live" /> : <Copy size={14} strokeWidth={1.75} />}
      {done ? 'Copied' : label}
    </button>
  )
}
