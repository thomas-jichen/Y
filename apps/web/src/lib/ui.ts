import { useSyncExternalStore } from 'react'

// Small app-wide UI state: palette, director, remote-instructions sheet.
type UI = { palette: boolean; director: boolean; remoteSheet: boolean }
let state: UI = { palette: false, director: false, remoteSheet: false }
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
