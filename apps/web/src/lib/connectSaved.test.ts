// The /connect install token saved in this tab belongs to one account (#55).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONNECT_KEY } from '@/api/auth'
import type { ConnectToken } from '@/api/types'
import { loadSaved, save } from './connectSaved'

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  }
}
const token = { token: 'pcl_agt_' + 'q'.repeat(32) } as ConnectToken

beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()))
afterEach(() => vi.unstubAllGlobals())

describe('per-account /connect state (#55)', () => {
  it('the same account gets its minted token back after a reload', () => {
    save('dev:alice', { tokens: { claudeCode: token }, installed: true })
    expect(loadSaved('dev:alice')).toEqual({ tokens: { claudeCode: token }, installed: true })
  })

  it('another account in the tab (reload after signing in elsewhere, duplicated tab) never sees it, and it is removed', () => {
    save('dev:alice', { tokens: { claudeCode: token }, installed: true })
    expect(loadSaved('dev:bob')).toEqual({ tokens: {}, installed: false })
    expect(sessionStorage.getItem(CONNECT_KEY)).toBeNull()
    expect(loadSaved('dev:alice')).toEqual({ tokens: {}, installed: false })
  })

  it('state saved without an owner (or with no account signed in) is never shown', () => {
    sessionStorage.setItem(CONNECT_KEY, JSON.stringify({ tokens: { claudeCode: token }, installed: true }))
    expect(loadSaved('sb:u1').tokens).toEqual({})
    expect(sessionStorage.getItem(CONNECT_KEY)).toBeNull()
    save(undefined, { tokens: { claudeCode: token }, installed: true })
    expect(sessionStorage.getItem(CONNECT_KEY)).toBeNull()
    save('sb:u1', { tokens: { claudeCode: token }, installed: false })
    expect(loadSaved(undefined).tokens).toEqual({})
  })
})
