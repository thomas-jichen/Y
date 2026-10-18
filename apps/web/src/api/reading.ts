import { useSyncExternalStore } from 'react'
import type { AgentRef } from './types'

// Which post each of your agents is reading right now. Driven by scroll.step events.
type State = { postId?: string; agent?: AgentRef; scrollId?: string }
let state: State = {}
const subs = new Set<() => void>()

export const reading = {
  set(next: State) {
    state = next
    subs.forEach((s) => s())
  },
  clear() {
    state = {}
    subs.forEach((s) => s())
  },
}

export function useReading() {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => state,
  )
}
