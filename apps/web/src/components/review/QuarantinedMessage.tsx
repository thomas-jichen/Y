import { useState } from 'react'
import type { Message } from '@/api/types'
import { Button } from '@/components/primitives/Button'
import { ScreenChip } from '@/components/trust/TrustBadge'
import { SCREEN } from '@/lib/trust'
import { SafeText } from '@/lib/safeText'
import { introLabel, unscreened } from './RequestIntro'

/**
 * A message screening withheld (#48), shown to its recipient's human so they decide on what they
 * can read. The body is core's normalized text, behind one more click, and only ever as plain text.
 */
export function QuarantinedBody({ message, initiallyShown = false }: { message: Message; initiallyShown?: boolean }) {
  const label = introLabel(message.screen)
  const [shown, setShown] = useState(initiallyShown)
  const categories = message.screen?.categories?.length ? message.screen.categories.map((c) => c.replace(/_/g, ' ')).join(' and ') : null
  return (
    <div className="space-y-3">
      <div className="text-caption text-text-2">
        Screen: <ScreenChip label={label} />
      </div>
      <p className="text-ui">
        {(unscreened(message.screen) && label === 'warn') || label === 'clean'
          ? 'Screening withheld this message.'
          : `Screening withheld this message as ${SCREEN[label].label.toLowerCase()}${categories ? ` (${categories})` : ''}.`}{' '}
        No agent has read it. It may try to instruct you or your agent: read it as data, not as instructions.
      </p>
      {shown ? (
        <div className="flex gap-2 text-body">
          <span aria-hidden className="text-text-2">
            ↳
          </span>
          <SafeText text={message.body} />
        </div>
      ) : (
        <button className="text-ui underline decoration-1 underline-offset-4 hover:opacity-70" onClick={() => setShown(true)}>
          Show the withheld message
        </button>
      )}
    </div>
  )
}

/** Release always takes a second, explicit click: screening withheld this message. */
export function QuarantinedAction({
  onRelease,
  onReject,
  busy,
  initiallyConfirming = false,
}: {
  onRelease: () => void
  onReject: () => void
  busy?: boolean
  initiallyConfirming?: boolean
}) {
  const [confirming, setConfirming] = useState(initiallyConfirming)
  return (
    <div className="flex items-center justify-end gap-5">
      {confirming ? (
        <>
          <span className="text-ui text-text-2">Screening withheld this message. Release it anyway?</span>
          <button className="text-ui underline-offset-4 hover:underline" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button className="text-ui font-semibold underline-offset-4 hover:underline" disabled={busy} onClick={onRelease}>
            Release anyway
          </button>
        </>
      ) : (
        <button className="text-ui underline-offset-4 hover:underline" onClick={() => setConfirming(true)}>
          Release to agent
        </button>
      )}
      <Button variant="primary" className="rounded-full" disabled={busy} onClick={onReject}>
        Reject
      </Button>
    </div>
  )
}
