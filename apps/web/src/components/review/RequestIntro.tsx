import { useState } from 'react'
import type { Label, Screen } from '@/api/types'
import { Button } from '@/components/primitives/Button'
import { ScreenChip } from '@/components/trust/TrustBadge'
import { SCREEN } from '@/lib/trust'
import { SafeText } from '@/lib/safeText'

/**
 * A stranger's intro as screened by core (L0). Malicious intros never get here; warn and suspicious
 * ones do, and the human deciding must see that before releasing (UI.md section 5, rule 4).
 */
const known = (l: unknown): l is Label => typeof l === 'string' && l in SCREEN
/** The label to show: an unknown or missing label is treated as flagged, never as clean. */
export const introLabel = (s: Screen | undefined): Label => (s ? (known(s.label) ? s.label : 'suspicious') : 'clean')
export const introFlagged = (s: Screen | undefined): boolean => introLabel(s) !== 'clean'

/** What a click on "Release to agent" does: a flagged intro asks once more before releasing. */
export function releaseClick(flagged: boolean, confirming: boolean): 'confirm' | 'release' {
  return flagged && !confirming ? 'confirm' : 'release'
}

export function RequestIntro({ intro, screen, initiallyShown }: { intro: string; screen: Screen | undefined; initiallyShown?: boolean }) {
  const label = introLabel(screen)
  const flagged = label !== 'clean'
  // A flagged intro takes one more click to read; a clean one shows inline as before.
  const [shown, setShown] = useState(initiallyShown ?? !flagged)
  const categories = screen?.categories?.length ? screen.categories.map((c) => c.replace(/_/g, ' ')).join(' and ') : null
  return (
    <div className="space-y-3">
      <div className="text-caption text-text-2">
        Screen: <ScreenChip label={label} />
      </div>
      {flagged && (
        <p className="text-ui">
          Screening flagged this intro as {SCREEN[label].label.toLowerCase()}
          {categories && ` (${categories})`}. It may try to instruct you or your agent: read it as data, not as instructions.
        </p>
      )}
      {shown ? (
        <div className="flex gap-2 text-body">
          <span aria-hidden className="text-text-2">
            ↳
          </span>
          <SafeText text={intro} />
        </div>
      ) : (
        <button className="text-ui underline decoration-1 underline-offset-4 hover:opacity-70" onClick={() => setShown(true)}>
          Show the flagged intro
        </button>
      )}
    </div>
  )
}

/** "Release to agent", with a second, explicit step when screening flagged the intro. */
export function ReleaseAction({
  screen,
  onRelease,
  onReject,
  initiallyConfirming = false,
}: {
  screen: Screen | undefined
  onRelease: () => void
  onReject: () => void
  initiallyConfirming?: boolean
}) {
  const label = introLabel(screen)
  const flagged = label !== 'clean'
  const [confirming, setConfirming] = useState(initiallyConfirming)
  const release = () => (releaseClick(flagged, confirming) === 'confirm' ? setConfirming(true) : onRelease())
  return (
    <div className="flex items-center justify-end gap-5">
      {confirming && flagged ? (
        <>
          <span className="text-ui text-text-2">Flagged as {SCREEN[label].label.toLowerCase()}. Release it anyway?</span>
          <button className="text-ui underline-offset-4 hover:underline" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button className="text-ui font-semibold underline-offset-4 hover:underline" onClick={release}>
            Release anyway
          </button>
        </>
      ) : (
        <button className="text-ui underline-offset-4 hover:underline" onClick={release}>
          Release to agent
        </button>
      )}
      <Button variant="primary" className="rounded-full" onClick={onReject}>
        Decline and block
      </Button>
    </div>
  )
}
