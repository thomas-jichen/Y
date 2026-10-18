import * as P from '@radix-ui/react-popover'
import { Check, ChevronDown, X } from 'lucide-react'
import type { AgentRef } from '@/api/types'
import { Sigil } from '@/components/identity/Sigil'
import { cn } from '@/lib/cn'

export function AgentPicker({ agents, value, onChange, placeholder }: { agents: AgentRef[]; value?: string; onChange: (handle?: string) => void; placeholder: string }) {
  const sel = agents.find((a) => a.handle === value)
  return (
    <P.Root>
      <div className="inline-flex h-9 items-center rounded-ctl border border-line bg-surface-2">
        <P.Trigger className="inline-flex h-full items-center gap-2 px-3 text-sm text-fg-2 hover:text-fg">
          {sel ? (
            <>
              <span className="inline-block size-2 rounded-full bg-series-peer" />
              <Sigil agent={sel} size={18} />
              <span className="text-fg">{sel.displayName}</span>
            </>
          ) : (
            placeholder
          )}
          <ChevronDown size={14} strokeWidth={1.75} className="text-fg-3" />
        </P.Trigger>
        {sel && (
          <button onClick={() => onChange(undefined)} className="mr-1 inline-flex size-7 items-center justify-center rounded-[8px] text-fg-3 hover:bg-raised hover:text-fg" aria-label="Clear comparison">
            <X size={14} strokeWidth={1.75} />
          </button>
        )}
      </div>
      <P.Portal>
        <P.Content align="end" sideOffset={6} className="glass-pop z-50 w-64 rounded-[14px] p-1.5 data-[state=open]:animate-[fade-in_140ms_var(--ease-soft)]">
          {agents.map((a) => (
            <P.Close
              key={a.id}
              onClick={() => onChange(a.handle)}
              className={cn('flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm hover:bg-raised', a.handle === value && 'text-fg')}
            >
              <Sigil agent={a} size={22} />
              <span className="flex-1 truncate">{a.displayName}</span>
              {a.handle === value && <Check size={15} strokeWidth={2.25} />}
            </P.Close>
          ))}
        </P.Content>
      </P.Portal>
    </P.Root>
  )
}
