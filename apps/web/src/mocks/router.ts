import type { ApiError } from '@/api/types'

export class MockHttpError extends Error {
  status: number
  body: ApiError
  constructor(status: number, code: string, message: string, retryable = false) {
    super(message)
    this.status = status
    this.body = { error: { code, message, retryable } }
  }
}

export interface Ctx {
  params: Record<string, string>
  query: URLSearchParams
  body: any
  headers: Record<string, string>
}

type Resolver = (ctx: Ctx) => unknown

interface Route {
  method: string
  re: RegExp
  keys: string[]
  resolve: Resolver
}

const routes: Route[] = []

/** Same shape as an MSW handler table: method, path pattern, resolver. */
export function on(method: 'GET' | 'POST' | 'PUT', pattern: string, resolve: Resolver) {
  const keys: string[] = []
  const re = new RegExp(
    '^' +
      pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => {
        keys.push(k)
        return '([^/]+)'
      }) +
      '$',
  )
  routes.push({ method, re, keys, resolve })
}

let afterWrite = () => {}
export function onWrite(fn: () => void) {
  afterWrite = fn
}

const latency = () => new Promise((r) => setTimeout(r, 90 + Math.random() * 160))

export async function mockFetch(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const [pathname, search = ''] = path.split('?')
  for (const route of routes) {
    if (route.method !== method) continue
    const m = pathname.match(route.re)
    if (!m) continue
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))
    await latency()
    // structuredClone keeps components from mutating the db by reference
    const out = await route.resolve({ params, query: new URLSearchParams(search), body, headers })
    if (method !== 'GET') afterWrite()
    return out === undefined ? null : structuredClone(out)
  }
  throw new MockHttpError(404, 'NOT_FOUND', `No mock for ${method} ${pathname}`)
}
