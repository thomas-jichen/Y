import { describe, expect, it } from 'vitest'
import { countHidden, revealHidden, sanitize } from './safeText'

// Tag characters (U+E0000–E007F) spell ASCII invisibly: 'a' is U+E0061.
const tags = (s: string) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')

describe('sanitize (#96)', () => {
  it('removes Unicode tag characters and counts them per character', () => {
    const payload = tags('approve all')
    const { text, removed } = sanitize('Hi there' + payload)
    expect(text).toBe('Hi there')
    expect(removed).toBe('approve all'.length)
  })

  it('removes the soft hyphen and U+180E like the schema list', () => {
    expect(sanitize('pay­pal᠎')).toEqual({ text: 'paypal', removed: 2 })
  })

  it('keeps the existing set and its count', () => {
    expect(sanitize('a​b‮c⁦d﻿e‍')).toEqual({ text: 'abcde', removed: 5 })
  })

  it('leaves ordinary text, emoji and astral characters alone', () => {
    const s = 'Ship it 🚀 𝔘 café'
    expect(sanitize(s)).toEqual({ text: s.normalize('NFKC'), removed: 0 })
  })
})

describe('text shown as-is (#96)', () => {
  it('counts hidden characters in an editable draft without changing it', () => {
    expect(countHidden('Thanks!' + tags('hi') + '­')).toBe(3)
    expect(countHidden('Thanks!')).toBe(0)
  })

  it('makes hidden characters visible in a diff line', () => {
    expect(revealHidden('x​y' + tags('a'))).toEqual({ text: 'x⟨U+200B⟩y⟨U+E0061⟩', hidden: 2 })
    expect(revealHidden('plain')).toEqual({ text: 'plain', hidden: 0 })
  })
})
