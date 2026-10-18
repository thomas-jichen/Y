import { HttpError } from '@/api/client'
import { ui } from './ui'

/** Runs a gated action; if instructions are off or the confirm is stale, opens the explain sheet. */
export async function gated<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof HttpError && (e.code === 'REMOTE_INSTRUCTIONS_OFF' || e.code === 'STEP_UP_REQUIRED')) {
      ui.set({ remoteSheet: true })
      return undefined
    }
    throw e
  }
}
