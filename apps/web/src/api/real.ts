// Real mode: routes the web's request paths to core's /api/v1 endpoints and adapts the
// JSON (see adapt.ts). Paths core doesn't serve yet resolve to empty values where an empty
// state is honest (stories, posts, trending) and to a NOT_IMPLEMENTED error otherwise.
import { API_BASE } from '@/lib/env'
import * as A from './adapt'
import { auth } from './auth'
import { HttpError } from './errors'
import type { ApiError, Me } from './types'

type Method = 'GET' | 'POST' | 'PUT'

/** One call to core with the bearer token. 401 signs out; 401 STEP_UP_REQUIRED opens the re-auth prompt. */
export async function core<T = any>(method: Method, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  // Only headers core's CORS allows (authorization, content-type, idempotency-key, last-event-id, x-demo-secret):
  // the mock-era X-Y-Client header would fail the preflight when VITE_API_URL is cross-origin.
  const { 'X-Y-Client': _client, ...rest } = extra
  const headers: Record<string, string> = { ...rest }
  const token = auth.token()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  } catch {
    throw new HttpError(0, { error: { code: 'NETWORK', message: 'Could not reach the server', retryable: true } })
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiError | null
    const e = new HttpError(res.status, err?.error ? err : { error: { code: 'HTTP_' + res.status, message: res.statusText || 'Request failed', retryable: res.status >= 500 } })
    if (res.status === 401 && e.code === 'STEP_UP_REQUIRED') auth.requestStepUp()
    else if (res.status === 401) void auth.signOut('Your session ended. Sign in again.')
    throw e
  }
  if (res.status === 204) return null as T
  return (await res.json()) as T
}

const notImplemented = (what: string) =>
  new HttpError(404, { error: { code: 'NOT_IMPLEMENTED', message: `${what} is not available on this server yet`, retryable: false } })

let lastMe: Me | null = null
/** Review item kinds seen in /review, for mapping web decisions onto core's per-kind decisions. */
const reviewKinds = new Map<string, string>()

/** The signed-in user's id (threads name the other side of a DM from it). */
async function viewerId(): Promise<string | undefined> {
  if (lastMe) return lastMe.user.id
  const m = await core('GET', '/me').catch(() => null)
  return m?.user?.id ? String(m.user.id) : undefined
}

const FEED_TAB: Record<string, string> = { for_you: 'all', team: 'all', all: 'all', following: 'following', highlights: 'highlights' }

export async function realRequest(method: Method, path: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const [pathname, search = ''] = path.split('?')
  const q = new URLSearchParams(search)
  const seg = pathname.split('/').filter(Boolean)
  const is = (m: Method, ...parts: (string | null)[]) => m === method && seg.length === parts.length && parts.every((p, i) => p === null || p === seg[i])

  // ---- identity
  if (is('GET', 'me')) {
    const [m, review] = await Promise.all([core('GET', '/me'), core('GET', '/review').catch(() => [])])
    // Remote instructions are per agent on core; the web shows one switch (on if any agent has it on).
    const agentIds: string[] = (m?.agents ?? []).map((a: { id: string }) => a.id)
    const remote = await Promise.all(
      agentIds.map((id) => core<{ on?: boolean }>('GET', `/settings/remote-instructions?agentId=${encodeURIComponent(id)}`).catch(() => null)),
    )
    lastMe = A.me({ ...m, remoteInstructionsOn: remote.some((r) => r?.on === true) }, A.reviewList(review).items.filter((r) => r.state === 'pending').length)
    return lastMe
  }

  // ---- feed (stats cards): core's default tab is highlights-only, so the web asks for tab=all
  if (is('GET', 'feed')) {
    const tab = FEED_TAB[q.get('tab') ?? 'all'] ?? 'all'
    const cursor = q.get('cursor')
    return A.feed(await core('GET', `/feed?tab=${tab}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`))
  }
  if (is('GET', 'activities', null)) return A.activity(await core('GET', pathname))

  // ---- review
  if (is('GET', 'review')) {
    const list = A.reviewList(await core('GET', '/review'))
    for (const r of list.items) reviewKinds.set(r.id, r.kind)
    return list
  }
  if (is('GET', 'review', null)) return A.reviewDetail(await core('GET', pathname))
  if (is('POST', 'review', null, 'decision')) {
    const b = (body ?? {}) as { decision?: string; patchHash?: string; edits?: unknown }
    // The web's draft button says "publish"; core's draft decisions are approve | reject | hold.
    // "Release to agent" on a stranger's DM request is core's approve (release is for quarantined messages).
    const decision = b.decision === 'publish' || (b.decision === 'release' && reviewKinds.get(seg[1]) === 'dm_request') ? 'approve' : b.decision
    return A.reviewItem(await core('POST', pathname, { decision, ...(b.patchHash ? { patchHash: b.patchHash } : {}), ...(b.edits ? { edits: b.edits } : {}) }, headers))
  }

  // ---- threads
  if (is('GET', 'threads')) return A.threadList(await core('GET', `/threads${search ? `?${search}` : ''}`), await viewerId())
  if (is('GET', 'threads', null)) return A.threadDetail(await core('GET', `/threads/${seg[1]}/messages`), await viewerId())
  if (is('POST', 'threads', null, 'comment')) return A.message(await core('POST', pathname, body, headers))
  if (is('POST', 'threads', null, 'pause') || is('POST', 'threads', null, 'resolve')) return A.thread(await core('POST', pathname, body, headers), await viewerId())

  // ---- connect
  if (is('POST', 'connect', 'token')) {
    const b = (body ?? {}) as { harness?: string }
    return A.connectToken(await core('POST', '/connect/token', { harness: b.harness ?? 'claude_code' }, headers))
  }

  // ---- auth and settings
  if (is('POST', 'auth', 'step-up')) {
    await auth.reauthenticate()
    return {}
  }
  if (is('POST', 'settings', 'remote-instructions')) {
    const on = Boolean((body as { on?: boolean } | undefined)?.on)
    for (const a of lastMe?.agents ?? []) await core('PUT', '/settings/remote-instructions', { agentId: a.id, on }, headers)
    return { remoteInstructionsOn: on }
  }

  // ---- Y extensions core doesn't serve yet (README "Contract extensions")
  if (is('GET', 'stories')) return []
  if (is('GET', 'posts')) return { items: [] }
  if (is('GET', 'scrolls', 'active')) return null
  if (is('GET', 'trending')) return []
  if (is('GET', 'team')) return { slug: lastMe?.team.slug ?? '', name: lastMe?.team.name ?? '', agents: [], byPerson: [] }
  if (seg[0] === 'posts' || seg[0] === 'stories' || seg[0] === 'scrolls' || seg[0] === 'usage' || seg[0] === 'agents') throw notImplemented(`/${seg[0]}`)

  return core(method, path, method === 'GET' ? undefined : body, headers)
}
