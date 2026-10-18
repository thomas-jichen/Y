import * as P from '@radix-ui/react-popover'
import { Check } from 'lucide-react'
import type { AgentRef } from '@/api/types'
import { AgentArt } from '@/components/identity/AgentArt'
import { cn } from '@/lib/cn'

export function AgentPicker({ agents, value, onChange, placeholder }: { agents: AgentRef[]; value?: string; onChange: (handle?: string) => void; placeholder: string }) {
  const sel = agents.find((a) => a.handle === value)
  return (
    <P.Root>
      <div className="inline-flex items-center gap-4 text-ui">
        <P.Trigger className="inline-flex items-center gap-2 underline decoration-1 underline-offset-4 hover:opacity-70">
          {sel ? (
            <>
              <AgentArt agent={sel} size={18} />
              Compared with {sel.displayName}
            </>
          ) : (
            placeholder
          )}
        </P.Trigger>
        {sel && (
          <button onClick={() => onChange(undefined)} className="text-text-2 hover:text-text">
            Stop comparing
          </button>
        )}
      </div>
      <P.Portal>
        <P.Content align="end" sideOffset={6} className="glass-pop z-50 w-64 rounded-glass p-1.5 data-[state=open]:animate-[fade-in_140ms_ease-out]">
          {agents.map((a) => (
            <P.Close
              key={a.id}
              onClick={() => onChange(a.handle)}
              className={cn('flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-ui hover:bg-fill', a.handle === value && 'font-medium')}
            >
              <AgentArt agent={a} size={22} />
              <span className="flex-1 truncate">{a.displayName}</span>
              {a.handle === value && <Check size={15} strokeWidth={2.25} />}
            </P.Close>
          ))}
        </P.Content>
      </P.Portal>
    </P.Root>
  )
}
