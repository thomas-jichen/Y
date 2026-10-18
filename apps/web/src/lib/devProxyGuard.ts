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

/** Connect middleware: 403 for a proxied /api request from another machine, unless `allowLan`. */
export function devProxyGuard(allowLan: boolean) {
  return (req: Req, res: Res, next: () => void) => {
    const path = req.url ?? ''
    if (allowLan || !(path === '/api' || path.startsWith('/api/') || path.startsWith('/api?')) || isLoopback(req.socket?.remoteAddress)) return next()
    res.statusCode = 403
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        error: { code: 'FORBIDDEN', message: 'The dev server proxies /api to this machine only. Set Y_WEB_LAN_API=1 to allow other devices.', retryable: false },
      }),
    )
  }
}
