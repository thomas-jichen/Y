import { describe, expect, it, vi } from 'vitest'
import { devProxyGuard, isLoopback, isProxied, lanBypass } from './devProxyGuard'

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
  })

  it('matches what Vite proxies: any URL starting /api, and dot-segment paths that normalise to it', () => {
    // Vite's matcher is url.startsWith('/api'); core receives the normalised path.
    for (const url of ['/apix', '/api.', '/apix/../api/v1/dev/login', '/api./../api/v1/dev/login', '/x/../api/v1/dev/login', '/./api/v1/me']) {
      expect(isProxied(url)).toBe(true)
      const { res, next } = run(devProxyGuard(false), url, '192.168.1.20')
      expect(next).not.toHaveBeenCalled()
      expect(res.statusCode).toBe(403)
    }
    expect(run(devProxyGuard(false), '/apix/../api/v1/dev/login', '127.0.0.1').next).toHaveBeenCalled()
    for (const url of ['/', '/connect', '/review/ri_1', '/src/main.tsx', '/@vite/client']) expect(isProxied(url)).toBe(false)
  })

  it('the proxy entry bypass refuses LAN peers for every request Vite is about to proxy', () => {
    const res = { statusCode: 200, headers: {} as Record<string, string>, body: '', setHeader(n: string, v: string) { this.headers[n] = v }, end(b?: string) { this.body = b ?? '' } }
    expect(lanBypass(false)({ url: '/apix/../api/v1/dev/login', socket: { remoteAddress: '192.168.1.20' } }, res)).toBe('/apix/../api/v1/dev/login')
    expect(res.statusCode).toBe(403)
    expect(lanBypass(false)({ url: '/api/v1/dev/login', socket: { remoteAddress: '::1' } }, res)).toBeUndefined()
    expect(lanBypass(true)({ url: '/api/v1/dev/login', socket: { remoteAddress: '192.168.1.20' } }, res)).toBeUndefined()
  })

  it('Y_WEB_LAN_API=1 opts the LAN back in', () => {
    expect(run(devProxyGuard(true), '/api/v1/dev/login', '192.168.1.20').next).toHaveBeenCalled()
  })
})
