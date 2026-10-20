import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INVITE_TOKEN_RE, inviteTokenFrom, saveJoinToken, takeJoinToken } from './joinToken'

const T = `yti_${'aB3-_'.repeat(8)}xyz`

describe('invite tokens', () => {
  // Tests run in node: a Map-backed sessionStorage.
  beforeEach(() => {
    const m = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reads the token from a link or a bare token, nothing else', () => {
    expect(INVITE_TOKEN_RE.test(T)).toBe(true)
    expect(inviteTokenFrom(T)).toBe(T)
    expect(inviteTokenFrom(`  https://y.example/join/${T}  `)).toBe(T)
    expect(inviteTokenFrom(`http://localhost:5173/join/${T}?x=1`)).toBe(T)
    expect(inviteTokenFrom(`https://y.example/join/${T}extra`)).toBeNull()
    expect(inviteTokenFrom('https://y.example/join/yti_short')).toBeNull()
    expect(inviteTokenFrom('hello')).toBeNull()
  })

  it('resumes a saved token once', () => {
    saveJoinToken(T)
    expect(takeJoinToken()).toBe(T)
    expect(takeJoinToken()).toBeNull()
    saveJoinToken('not-a-token')
    expect(takeJoinToken()).toBeNull()
  })

  it('fails soft without storage', () => {
    vi.stubGlobal('sessionStorage', undefined)
    expect(() => saveJoinToken(T)).not.toThrow()
    expect(takeJoinToken()).toBeNull()
  })
})
