import { CONNECT_KEY } from '@/api/auth'
import type { ConnectToken } from '@/api/types'

export type HarnessTab = 'claudeCode' | 'astra'

/**
 * The minted token and progress survive leaving the page and reloads within this browser tab
 * (sessionStorage), and are dropped when the tab closes or the account signs out (api/auth.ts). Core keeps only the hash.
 * Saved state names the account it belongs to (`AuthState.account`): another account in this tab (a
 * reload after signing in elsewhere, a duplicated tab) never sees it, and the entry is removed.
 */
const SAVED = CONNECT_KEY
export type Saved = { tokens: Partial<Record<HarnessTab, ConnectToken>>; installed: boolean }
export function loadSaved(owner: string | undefined): Saved {
  try {
    const v = JSON.parse(sessionStorage.getItem(SAVED) ?? 'null') as (Saved & { owner?: unknown }) | null
    if (v && typeof v === 'object' && v.tokens && typeof v.tokens === 'object') {
      if (owner && v.owner === owner) return { tokens: v.tokens, installed: !!v.installed }
      sessionStorage.removeItem(SAVED)
    }
  } catch {
    /* unavailable or corrupt: start over */
  }
  return { tokens: {}, installed: false }
}
export function save(owner: string | undefined, v: Saved) {
  if (!owner) return
  try {
    sessionStorage.setItem(SAVED, JSON.stringify({ owner, ...v }))
  } catch {
    /* private mode: progress lasts while the page is open */
  }
}

