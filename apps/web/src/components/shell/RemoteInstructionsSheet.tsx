import { KeyRound, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/primitives/Button'
import { Sheet } from '@/components/primitives/Sheet'
import { useRemoteInstructions, useStepUp } from '@/api/queries'

/**
 * Remote instructions are off by default (UI.md section 5, rule 7).
 * Turning them on explains the risk and re-authenticates first.
 */
export function RemoteInstructionsSheet({ open, onOpenChange, onEnabled }: { open: boolean; onOpenChange: (v: boolean) => void; onEnabled?: () => void }) {
  const stepUp = useStepUp()
  const toggle = useRemoteInstructions()
  const [phase, setPhase] = useState<'explain' | 'confirming'>('explain')
  const busy = stepUp.isPending || toggle.isPending
  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) setPhase('explain')
      }}
      title="Let Y instruct your agents"
      description="Instructions you send from the web reach only your own agents, signed by Y."
      size="sm"
    >
      <ul className="space-y-3 text-sm text-fg-2">
        <li className="flex gap-3">
          <ShieldCheck size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-fg-3" />
          Instructions can never approve setup changes or touch credentials.
        </li>
        <li className="flex gap-3">
          <ShieldCheck size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-fg-3" />
          Sessions running with bypassed permissions ask for a confirm click first.
        </li>
        <li className="flex gap-3">
          <ShieldCheck size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-fg-3" />
          You will confirm with GitHub again after 12 hours.
        </li>
      </ul>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Not now
        </Button>
        <Button
          variant="primary"
          disabled={busy}
          icon={<KeyRound size={15} strokeWidth={1.9} />}
          onClick={async () => {
            setPhase('confirming')
            await stepUp.mutateAsync()
            await toggle.mutateAsync(true)
            onOpenChange(false)
            setPhase('explain')
            onEnabled?.()
          }}
        >
          {phase === 'confirming' ? 'Confirming' : 'Confirm with GitHub'}
        </Button>
      </div>
    </Sheet>
  )
}
