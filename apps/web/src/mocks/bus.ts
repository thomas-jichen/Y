import type { StreamEvent } from '@/api/types'

type Listener = (e: StreamEvent) => void
const listeners = new Set<Listener>()

/** Stands in for EventSource('/api/v1/stream'). Payloads carry ids only. */
export const bus = {
  emit(e: StreamEvent) {
    listeners.forEach((l) => l(e))
  },
  subscribe(l: Listener) {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
}
