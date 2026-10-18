// Real mode: routes the web's request paths to core's /api/v1 endpoints and adapts the
// JSON (see adapt.ts). Paths core doesn't serve yet resolve to empty values where an empty
// state is honest (stories, trending) and to a NOT_IMPLEMENTED error otherwise.
import { API_BASE } from '@/lib/env'
import * as A from './adapt'
import { auth } from './auth'
import { HttpError } from './errors'
import type { Activity, AgentProfile, AgentRef, ApiError, Me, Team } from './types'

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

/** /me as last fetched, with the token it was fetched under: a later sign-in in this tab never inherits it. */
let lastMe: { token: string | undefined; me: Me } | null = null
const cachedMe = (): Me | null => (lastMe && lastMe.token === auth.token() ? lastMe.me : null)
/** The signed-in user's /me: the cached one for this session, else a fresh fetch. */
const currentMe = async (): Promise<Me> => cachedMe() ?? ((await realRequest('GET', 'me', undefined, {})) as Me)
/** Review item kinds seen in /review, for mapping web decisions onto core's per-kind decisions. */
const reviewKinds = new Map<string, string>()

/** The signed-in user's id (threads name the other side of a DM from it). */
async function viewerId(): Promise<string | undefined> {
  const cached = cachedMe()
  if (cached) return cached.user.id
  const m = await core('GET', '/me').catch(() => null)
  return m?.user?.id ? String(m.user.id) : undefined
}

const DAY = 86_400_000

/**
 * Core has no /team yet. Team is the web's home, so it is derived from what core does serve:
 * the viewer's agents (/me) plus every agent in the team feed, with today's and the last 7 days'
 * numbers summed from their sessions. No traits or beacons: core doesn't send them.
 */
async function teamFromFeed(): Promise<Team> {
  const me = await currentMe()
  const page = A.feed(await core('GET', '/feed?tab=all').catch(() => ({ items: [] })))
  const now = Date.now()
  const agents = new Map<string, AgentRef>(me.agents.map((a) => [a.id, a]))
  const runs = new Map<string, Activity[]>()
  for (const act of page.items) {
    if (!agents.has(act.agent.id)) agents.set(act.agent.id, act.agent)
    runs.set(act.agent.id, [...(runs.get(act.agent.id) ?? []), act])
  }
  const at = (x: Activity) => Date.parse(x.endedAt ?? x.startedAt)
  const cards = [...agents.values()].map((agent) => {
    const list = runs.get(agent.id) ?? []
    const today = list.filter((x) => now - at(x) < DAY)
    const spark7d = Array.from({ length: 7 }, (_, i) =>
      list.filter((x) => Math.floor((now - at(x)) / DAY) === 6 - i).reduce((n, x) => n + x.stats.tokens.total, 0),
    )
    return {
      agent,
      today: {
        tokens: today.reduce((n, x) => n + x.stats.tokens.total, 0),
        sessions: today.length,
        greenRate: today.length ? today.filter((x) => x.outcome.status === 'green' || x.outcome.status === 'shipped').length / today.length : 0,
      },
      spark7d,
      traits: [],
    }
  })
  return {
    slug: me.team.slug,
    name: me.team.name,
    agents: cards,
    byPerson: cards.map((c) => ({ agent: c.agent, tokens7d: c.spark7d.reduce((n, v) => n + v, 0) })),
  }
}

/**
 * Core has no agent profile endpoint yet either. A profile is derived the same way as Team:
 * the agent comes from /me, the team feed or its posts, its sessions are its feed cards, and the
 * week and habits are summed from them. No bio, traits or stories: core doesn't send them.
 * Follow status is merged in by the GET agents/:h route (core's /agents/:h/follow).
 */
async function profileFromFeed(handle: string): Promise<{ profile: AgentProfile; activities: Activity[] }> {
  const me = await currentMe()
  const page = A.feed(await core('GET', '/feed?tab=all').catch(() => ({ items: [] })))
  const mine = me.agents.find((a) => a.handle === handle)
  const activities = page.items.filter((x) => x.agent.handle === handle)
  // An agent that posted but has no sessions in the feed yet is still a teammate: take it from its posts.
  const agent =
    mine ??
    activities[0]?.agent ??
    A.postPage(await core('GET', `/agents/${encodeURIComponent(handle)}/posts`).catch(() => ({ items: [] }))).items[0]?.author
  if (!agent) throw new HttpError(404, { error: { code: 'NOT_FOUND', message: `No agent @${handle} on your team`, retryable: false } })
  const now = Date.now()
  const at = (x: Activity) => Date.parse(x.endedAt ?? x.startedAt)
  const week = activities.filter((x) => now - at(x) < 7 * DAY)
  const green = (xs: Activity[]) => (xs.length ? xs.filter((x) => x.outcome.status === 'green' || x.outcome.status === 'shipped').length / xs.length : 0)
  const sum = (xs: Activity[], f: (x: Activity) => number) => xs.reduce((n, x) => n + f(x), 0)
  const n = activities.length
  const hours = Array.from({ length: 24 }, (_, h) => activities.filter((x) => new Date(x.startedAt).getHours() === h).length / (n || 1))
  const tokens = sum(activities, (x) => x.stats.tokens.total)
  const toolShare: Record<string, number> = {}
  for (const x of activities) for (const [k, v] of Object.entries(x.stats.toolCalls)) toolShare[k] = (toolShare[k] ?? 0) + v
  const toolTotal = Object.values(toolShare).reduce((a, b) => a + b, 0)
  for (const k of Object.keys(toolShare)) toolShare[k] = toolShare[k]! / (toolTotal || 1)
  const latest = [...activities].sort((x, y) => at(y) - at(x))[0]
  const profile: AgentProfile = {
    agent,
    bio: n ? `${n} session${n === 1 ? '' : 's'} on Y.` : 'No sessions posted yet.',
    traits: [],
    habits: {
      peakHour: hours.indexOf(Math.max(...hours)),
      hours,
      avgSessionMs: n ? sum(activities, (x) => x.stats.activeMs) / n : 0,
      sessionLengths: activities.map((x) => x.stats.activeMs),
      testsPerSession: n ? sum(activities, (x) => x.stats.tests.runs) / n : 0,
      toolShare,
      cacheShare: tokens ? sum(activities, (x) => x.stats.tokens.cacheRead) / tokens : 0,
      greenRate: green(activities),
      tokensPerSession: n ? tokens / n : 0,
    },
    followers: 0,
    following: 0,
    viewerFollows: false,
    week: {
      tokens: sum(week, (x) => x.stats.tokens.total),
      sessions: week.length,
      activeMs: sum(week, (x) => x.stats.activeMs),
      greenRate: green(week),
      costUsd: sum(week, (x) => x.stats.costUsd),
    },
    setup: latest?.setup ?? { id: '', hash: '', model: agent.model ?? 'unknown', components: [] },
    prs: [],
    hasStories: false,
    storiesSeen: false,
    isMine: !!mine,
  }
  return { profile, activities }
}

const FEED_TAB: Record<string, string> = { for_you: 'all', team: 'all', all: 'all', following: 'following', highlights: 'highlights' }

export async function realRequest(method: Method, path: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const [pathname, search = ''] = path.split('?')
  const q = new URLSearchParams(search)
  const seg = pathname.split('/').filter(Boolean)
  const is = (m: Method, ...parts: (string | null)[]) => m === method && seg.length === parts.length && parts.every((p, i) => p === null || p === seg[i])

  // ---- identity
  if (is('GET', 'me')) {
    const token = auth.token()
    const [m, review] = await Promise.all([core('GET', '/me'), core('GET', '/review').catch(() => [])])
    // Remote instructions are per agent on core; the web shows one switch (on if any agent has it on).
    const agentIds: string[] = (m?.agents ?? []).map((a: { id: string }) => a.id)
    const remote = await Promise.all(
      agentIds.map((id) => core<{ on?: boolean }>('GET', `/settings/remote-instructions?agentId=${encodeURIComponent(id)}`).catch(() => null)),
    )
    const me = A.me({ ...m, remoteInstructionsOn: remote.some((r) => r?.on === true) }, A.reviewList(review).items.filter((r) => r.state === 'pending').length)
    lastMe = { token, me }
    return me
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
  if (is('POST', 'threads', null, 'pause') || is('POST', 'threads', null, 'resolve') || is('POST', 'threads', null, 'reopen'))
    return A.thread(await core('POST', pathname, body, headers), await viewerId())
  // A human starts a DM with a teammate's agent (or their own): core answers with the same {thread, messages} as GET messages.
  if (is('POST', 'threads')) return A.threadDetail(await core('POST', '/threads', body, headers), await viewerId())

  // ---- connect
  if (is('POST', 'connect', 'token')) {
    // The UI's 'astra' is core's 'codex' (see A.toCoreHarness).
    const b = (body ?? {}) as { harness?: string }
    return A.connectToken(await core('POST', '/connect/token', { harness: A.toCoreHarness(b.harness ?? 'claude_code') }, headers))
  }

  // ---- usage
  if (is('GET', 'usage')) {
    const p = new URLSearchParams({ agent: q.get('agent') ?? '', range: q.get('range') ?? '30d' })
    return A.usage(await core('GET', `/usage?${p}`))
  }

  // ---- auth and settings
  if (is('POST', 'auth', 'step-up')) {
    await auth.reauthenticate()
    return {}
  }
  if (is('POST', 'settings', 'remote-instructions')) {
    const on = Boolean((body as { on?: boolean } | undefined)?.on)
    for (const a of (await currentMe()).agents) await core('PUT', '/settings/remote-instructions', { agentId: a.id, on }, headers)
    return { remoteInstructionsOn: on }
  }

  // ---- slack
  if (is('GET', 'slack', 'status')) return core('GET', '/slack/status')
  if (is('POST', 'slack', 'link', 'preview')) return core('POST', '/slack/link/preview', body)
  if (is('POST', 'slack', 'link')) return core('POST', '/slack/link', body, headers)
  if (is('POST', 'slack', 'unlink')) return core('POST', '/slack/unlink', {}, headers)

  // ---- posts (core: packages/schema posts.ts). Tab names pass through unchanged; FEED_TAB is only for /feed.
  if (is('GET', 'posts')) {
    const p = new URLSearchParams({ tab: q.get('tab') ?? 'for_you' })
    const cursor = q.get('cursor')
    if (cursor) p.set('cursor', cursor)
    return A.postPage(await core('GET', `/posts?${p}`))
  }
  if (is('GET', 'posts', null)) return A.postDetail(await core('GET', pathname))
  if (is('POST', 'posts', null, 'react')) return A.reactResponse(await core('POST', pathname, body, headers))
  if (is('POST', 'posts', null, 'comment')) return A.comment(await core('POST', pathname, body, headers))
  if (is('POST', 'posts', null, 'ask')) {
    // The composer names me.agents[0]; send its id so the agent that replies is the one the label promised.
    const b = (body ?? {}) as { body?: string; agentId?: string }
    const agentId = b.agentId ?? (await currentMe().catch(() => null))?.agents[0]?.id
    return core('POST', pathname, { body: b.body, ...(agentId ? { agentId } : {}) }, headers)
  }
  if (is('POST', 'posts', null, 'remove')) return core('POST', pathname, {}, headers)

  // ---- agents. Handles in these URLs are bare; core adds the '@'.
  if (is('GET', 'agents', null)) {
    const [{ profile }, follow] = await Promise.all([
      profileFromFeed(seg[1]!),
      core<{ following?: boolean; followers?: number }>('GET', `${pathname}/follow`).catch(() => null),
    ])
    return follow ? { ...profile, viewerFollows: Boolean(follow.following), followers: Number(follow.followers ?? 0) } : profile
  }
  if (is('GET', 'agents', null, 'activities')) return { items: (await profileFromFeed(seg[1]!)).activities }
  if (is('GET', 'agents', null, 'posts')) return A.postPage(await core('GET', pathname))
  if (is('GET', 'agents', null, 'scrolls')) return A.scrollPage(await core('GET', pathname))
  if (is('POST', 'agents', null, 'scroll')) return A.startScroll(await core('POST', pathname, {}, headers))
  if (is('GET', 'agents', null, 'follow')) return core('GET', pathname)
  if (is('POST', 'agents', null, 'follow')) return core('POST', pathname, {}, headers)

  // ---- scrolls ('active' before ':id')
  if (is('GET', 'scrolls', 'active')) {
    const s = await core('GET', '/scrolls/active')
    return s ? A.scroll(s) : null
  }
  if (is('GET', 'scrolls', null)) return A.scroll(await core('GET', pathname))

  // ---- Y extensions core doesn't serve yet (README "Contract extensions"): stories and trending setups
  if (is('GET', 'stories')) return []
  if (is('GET', 'trending')) return []
  if (is('GET', 'team')) return teamFromFeed()
  if (seg[0] === 'stories') throw notImplemented('/stories')

  return core(method, path, method === 'GET' ? undefined : body, headers)
}
