import { HttpError } from '@/api/client'
import { ui } from './ui'

/** Core's "this agent hasn't granted remote instructions" answer: SCOPE_FORBIDDEN asking for a human grant. */
const needsGrant = (e: HttpError) => e.code === 'SCOPE_FORBIDDEN' && (e.body.error as { next?: { humanAction?: string } }).next?.humanAction === 'grant_permission'

/** Runs a gated action; if instructions are off, not granted, or the confirm is stale, opens the explain sheet. */
export async function gated<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof HttpError && (e.code === 'REMOTE_INSTRUCTIONS_OFF' || e.code === 'STEP_UP_REQUIRED' || needsGrant(e))) {
      ui.set({ remoteSheet: true })
      return undefined
    }
    throw e
  }
}
