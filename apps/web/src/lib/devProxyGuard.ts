// Dev and preview servers only (vite.config.ts); never bundled into the app.
//
// The dev server listens on every interface (phone testing on the LAN), and in real mode it proxies
// /api to a local core whose dev login needs no secret. Without this guard anyone on the same
// network could sign in as the developer through http://<lan-ip>:5173/api/v1/dev/login.
// Proxied /api requests are served to this machine only, unless Y_WEB_LAN_API=1 opts in.

/** True for a loopback peer address (IPv4 127/8, IPv6 ::1, IPv4-mapped ::ffff:127.x). */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false
  const a = addr.toLowerCase().replace(/^::ffff:/, '')
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

type Req = { url?: string; socket?: { remoteAddress?: string } }
type Res = { statusCode: number; setHeader(name: string, value: string): unknown; end(body?: string): unknown }

/**
 * True when Vite would proxy `url` for `context`, or when it would once normalised. Vite's matcher
 * is a bare `url.startsWith(context)` on the raw URL ('/apix' and '/api./../api/…' match), and the
 * proxied path is normalised on its way to core, so both forms are checked.
 */
export function isProxied(url: string | undefined, context = '/api'): boolean {
  const raw = url ?? ''
  if (raw.startsWith(context)) return true
  try {
    return new URL(raw, 'http://dev.invalid').pathname.startsWith(context)
  } catch {
    return true // unparseable: refuse rather than guess
  }
}

function refuse(res: Res) {
  res.statusCode = 403
  res.setHeader('Content-Type', 'application/json')
  res.end(
    JSON.stringify({
      error: { code: 'FORBIDDEN', message: 'The dev server proxies /api to this machine only. Set Y_WEB_LAN_API=1 to allow other devices.', retryable: false },
    }),
  )
}

const allowed = (allowLan: boolean, req: Req) => allowLan || isLoopback(req.socket?.remoteAddress)

/** Connect middleware, ahead of the proxy: 403 for a proxied /api request from another machine, unless `allowLan`. */
export function devProxyGuard(allowLan: boolean, context = '/api') {
  return (req: Req, res: Res, next: () => void) => {
    if (!isProxied(req.url, context) || allowed(allowLan, req)) return next()
    refuse(res)
  }
}

/**
 * The same check inside the proxy entry itself (`server.proxy['/api'].bypass`), so it runs on exactly
 * the requests Vite is about to proxy, whatever their path looks like. Returning the URL after
 * answering makes Vite stop (it returns once the response has ended).
 */
export function lanBypass(allowLan: boolean) {
  return (req: Req, res: Res | undefined): string | undefined => {
    if (allowed(allowLan, req)) return undefined
    if (res) refuse(res)
    return req.url ?? '/'
  }
}
