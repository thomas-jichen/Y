import { afterEach, describe, expect, it, vi } from 'vitest'
import { matchRepo, parseRepo, setStoredRepo } from './repoScope'

describe('parseRepo', () => {
  it('accepts GitHub owner/repo names and nothing else', () => {
    expect(parseRepo('acme/web')).toBe('acme/web')
    expect(parseRepo('Acme-Co/rocket.js')).toBe('Acme-Co/rocket.js')
    for (const bad of ['', 'acme', 'acme/web.git', 'acme/..', '-acme/web', 'acme/web/extra', 'acme/we b', 'a'.repeat(40) + '/x', 42, null, undefined])
      expect(parseRepo(bad), String(bad)).toBeUndefined()
  })
})

describe('matchRepo', () => {
  it('matches a linked repo case-insensitively and returns its linked spelling', () => {
    expect(matchRepo('acme/WEB', ['Acme/Web', 'acme/api'])).toBe('Acme/Web')
    expect(matchRepo('acme/gone', ['Acme/Web'])).toBeNull()
    expect(matchRepo(null, ['Acme/Web'])).toBeNull()
  })
})

describe('setStoredRepo', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('remembers the choice in localStorage', () => {
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) })
    setStoredRepo('acme/web')
    expect(mem.get('y.repo')).toBe('acme/web')
    setStoredRepo('not a repo')
    expect(mem.has('y.repo')).toBe(false)
    setStoredRepo(null)
    expect(mem.has('y.repo')).toBe(false)
  })

  it('never throws when storage is unavailable', () => {
    const boom = () => {
      throw new Error('SecurityError')
    }
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom })
    expect(() => setStoredRepo('acme/web')).not.toThrow()
    expect(() => setStoredRepo(null)).not.toThrow()
  })
})
