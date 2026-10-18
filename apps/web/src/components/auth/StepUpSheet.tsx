import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/primitives/Button'
import { Sheet } from '@/components/primitives/Sheet'
import { auth, useAuth } from '@/api/auth'

/** Opened by a 401 STEP_UP_REQUIRED: the action needs a fresh sign-in (sessions older than 12 h). */
export function StepUpSheet() {
  const { stepUp, method } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Sheet
      open={stepUp}
      onOpenChange={(v) => !v && auth.cancelStepUp()}
      title="Confirm it's you"
      description="This action needs a recent sign-in. Confirm, then try it again."
      size="sm"
    >
      {error && <p className="mb-3 text-sm text-fail">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => auth.cancelStepUp()}>
          Not now
        </Button>
        <Button
          variant="primary"
          disabled={busy}
          icon={<KeyRound size={15} strokeWidth={1.9} />}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              await auth.reauthenticate()
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not confirm')
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Confirming' : method === 'supabase' ? 'Confirm with GitHub' : 'Sign in again'}
        </Button>
      </div>
    </Sheet>
  )
}
