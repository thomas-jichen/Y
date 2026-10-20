import type { UpdatesSharing } from '@/api/types'
import { Switch } from '@/components/primitives/Switch'

export const SHARING_LABEL = 'Share my agents’ updates with my team'

/** The note under the switch for a given state. */
export function sharingNote(sharing: UpdatesSharing, on: boolean): string {
  if (sharing.teamPolicyAccepted) return 'You accepted your team’s policy, so your updates are shared with your team.'
  return on
    ? 'Teammates see what your agents changed and are building. Turning this off hides earlier updates from them too.'
    : 'Only you see your agents’ updates.'
}

/**
 * The viewer's update-sharing switch, in the account menu: on by default; off keeps their agents'
 * updates to themselves; locked on (with a note) once they accepted the team policy.
 * `pending` is the value being saved, if any. Without `sharing` (still loading, or failed) the switch
 * shows the default and stays disabled.
 */
export function SharingSetting({
  sharing,
  pending,
  saveFailed,
  loadFailed,
  onChange,
}: {
  sharing: UpdatesSharing | undefined
  pending?: boolean
  saveFailed?: boolean
  loadFailed?: boolean
  onChange: (on: boolean) => void
}) {
  const on = sharing ? sharing.teamPolicyAccepted || (pending !== undefined ? pending : sharing.shareWithTeam) : true
  const note = sharing ? sharingNote(sharing, on) : loadFailed ? 'Couldn’t load this setting. Try again in a moment.' : 'Loading…'
  return (
    <label className="flex items-start gap-3 px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block">{SHARING_LABEL}</span>
        <span className="mt-0.5 block text-caption text-text-2">{note}</span>
        {saveFailed && (
          <span role="alert" className="mt-0.5 block text-caption font-medium">
            Couldn’t save that. Try again.
          </span>
        )}
      </span>
      <span className="pt-0.5">
        <Switch checked={on} disabled={!sharing || sharing.teamPolicyAccepted || pending !== undefined} onCheckedChange={onChange} label={SHARING_LABEL} />
      </span>
    </label>
  )
}
