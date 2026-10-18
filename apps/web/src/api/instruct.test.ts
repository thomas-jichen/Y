// "Instruct my agent" sends one Idempotency-Key per gesture, so core signs one instruction (#29).
import { describe, expect, it, vi } from 'vitest'
import { gestureKeys } from '@/lib/idempotency'
import { api } from './client'
import { instructSender } from './queries'

function fakePost(fail: () => boolean = () => false) {
  const keys: (string | undefined)[] = []
  const post = vi.fn(async (_path: string, _body?: unknown, key?: string) => {
    keys.push(key)
    if (fail()) throw new Error('500 after commit')
    return { id: 'oi_1' }
  })
  return { post: post as unknown as typeof api.post, keys, calls: post.mock.calls }
}

describe('owner instruction idempotency (#29)', () => {
  it('sends an explicit Idempotency-Key to the instruct endpoint', async () => {
    const f = fakePost()
    await instructSender('t_1', f.post)('run the tests')
    expect(f.calls[0]?.[0]).toBe('/threads/t_1/instruct')
    expect(f.calls[0]?.[1]).toEqual({ body: 'run the tests' })
    expect(f.keys[0]).toMatch(/^idem_[0-9a-f]{12}$/)
  })

  it('a double submit of the same text reuses one key', async () => {
    const f = fakePost()
    const send = instructSender('t_1', f.post)
    await Promise.all([send('run the tests'), send('run the tests')])
    expect(f.keys).toHaveLength(2)
    expect(f.keys[0]).toBe(f.keys[1])
  })

  it('a resend after a failure reuses the key; a later new gesture gets a new one', async () => {
    let failing = true
    const f = fakePost(() => failing)
    const send = instructSender('t_1', f.post)
    await expect(send('run the tests')).rejects.toThrow()
    failing = false
    await send('run the tests')
    expect(f.keys[1]).toBe(f.keys[0])
    // Sent once and confirmed: asking again is a new instruction.
    await send('run the tests')
    expect(f.keys[2]).not.toBe(f.keys[1])
  })

  it('different text is a different gesture', async () => {
    const f = fakePost()
    const send = instructSender('t_1', f.post)
    await send('run the tests')
    await send('fix the lint')
    expect(f.keys[0]).not.toBe(f.keys[1])
  })

  it('gestureKeys keeps a key until that payload is done', () => {
    let n = 0
    const k = gestureKeys(() => `k${++n}`)
    expect(k.key('a')).toBe('k1')
    expect(k.key('a')).toBe('k1')
    k.done('b')
    expect(k.key('a')).toBe('k1')
    k.done('a')
    expect(k.key('a')).toBe('k2')
    expect(k.key('b')).toBe('k3')
  })
})
