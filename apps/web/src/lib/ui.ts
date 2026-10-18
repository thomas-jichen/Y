import { useSyncExternalStore } from 'react'

// Small app-wide UI state: palette, director, remote-instructions sheet, new-message sheet.
// `compose` is open when set; `to` prefills the agent handle.
type UI = { palette: boolean; director: boolean; remoteSheet: boolean; compose: { to?: string } | null }
let state: UI = { palette: false, director: false, remoteSheet: false, compose: null }
const subs = new Set<() => void>()

export const ui = {
  set(patch: Partial<UI>) {
    state = { ...state, ...patch }
    subs.forEach((s) => s())
  },
  get: () => state,
}

export function useUI() {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => state,
  )
}
