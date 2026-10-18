import { describe, expect, it, vi } from 'vitest'
import { devProxyGuard, isLoopback } from './devProxyGuard'

function run(guard: ReturnType<typeof devProxyGuard>, url: string, remoteAddress: string) {
  const res = { statusCode: 200, headers: {} as Record<string, string>, body: '', setHeader(n: string, v: string) { this.headers[n] = v }, end(b?: string) { this.body = b ?? '' } }
  const next = vi.fn()
  guard({ url, socket: { remoteAddress } }, res, next)
  return { res, next }
}

describe('dev server /api proxy guard (#97)', () => {
  it('knows loopback peers', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a)).toBe(true)
    for (const a of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', 'fe80::1', '', undefined]) expect(isLoopback(a)).toBe(false)
  })

  it('refuses the proxied dev login to another machine on the LAN', () => {
    const { res, next } = run(devProxyGuard(false), '/api/v1/dev/login', '192.168.1.20')
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN')
  })

  it('serves /api to this machine, and the app itself to anyone (phone testing)', () => {
    expect(run(devProxyGuard(false), '/api/v1/dev/login', '127.0.0.1').next).toHaveBeenCalled()
    expect(run(devProxyGuard(false), '/api/v1/me', '::1').next).toHaveBeenCalled()
    expect(run(devProxyGuard(false), '/', '192.168.1.20').next).toHaveBeenCalled()
    expect(run(devProxyGuard(false), '/connect', '192.168.1.20').next).toHaveBeenCalled()
    expect(run(devProxyGuard(false), '/apix', '192.168.1.20').next).toHaveBeenCalled()
  })

  it('Y_WEB_LAN_API=1 opts the LAN back in', () => {
    expect(run(devProxyGuard(true), '/api/v1/dev/login', '192.168.1.20').next).toHaveBeenCalled()
  })
})
