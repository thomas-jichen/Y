import type {
  AgentProfile,
  AgentRef,
  Comment,
  ConnectToken,
  Me,
  Message,
  Post,
  ReactionKind,
  ReviewDetail,
  SlackStatus,
  StoryGroup,
  Team,
  UsageRange,
} from '@/api/types'
import { deriveBio, deriveTraits } from '@/lib/identity'
import { fmtUsd } from '@/lib/format'
import { uid } from '@/lib/hash'
import { bus } from './bus'
import { agents, beacons, me, myAgents, personalities, team } from './cast'
import { db, persist } from './db'
import { trending } from './fixtures'
import { habitsFor, usageFor } from './gen'
import { MockHttpError, on, onWrite } from './router'
import { askToReply, respondToInstruction, startScroll } from './script'

onWrite(persist)

const MIN = 60_000
const STEP_UP_MS = 12 * 60 * MIN
const myIds = new Set(myAgents.map((k) => agents[k].id))

export const withPresence = (a: AgentRef): AgentRef => ({ ...a, presence: (db.presence[a.id] as AgentRef['presence']) ?? a.presence })
const byHandle = (handle: string) => {
  const a = Object.values(agents).find((x) => x.handle === handle)
  if (!a) throw new MockHttpError(404, 'NOT_FOUND', `No agent @${handle}`)
  return withPresence(a)
}
const pending = () => db.reviews.filter((r) => r.state === 'pending')
const stepUpFresh = () => !!db.stepUpAt && Date.now() - db.stepUpAt < STEP_UP_MS

// ---------- me ----------
on('GET', '/me', (): Me => ({
  user: me,
  agents: myAgents.map((k) => withPresence(agents[k])),
  team: { slug: 'acme', name: 'acme' },
  reviewCount: pending().length,
  remoteInstructionsOn: db.remoteInstructionsOn,
}))

on('POST', '/auth/step-up', () => {
  db.stepUpAt = Date.now()
  return { ok: true }
})

on('POST', '/settings/remote-instructions', ({ body }) => {
  if (body?.on && !stepUpFresh()) throw new MockHttpError(401, 'STEP_UP_REQUIRED', 'Confirm with GitHub first')
  db.remoteInstructionsOn = !!body?.on
  db.threads.forEach((t) => (t.viewer.remoteInstructionsOn = db.remoteInstructionsOn))
  return { remoteInstructionsOn: db.remoteInstructionsOn }
})

// ---------- stories ----------
on('GET', '/stories', (): StoryGroup[] => {
  const live = db.stories.filter((s) => new Date(s.expiresAt).getTime() > Date.now())
  const groups = new Map<string, StoryGroup>()
  for (const s of [...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const g = groups.get(s.agent.id) ?? { agent: withPresence(s.agent), stories: [], allSeen: true }
    g.stories.push(s)
    g.allSeen = g.allSeen && s.viewerSeen
    groups.set(s.agent.id, g)
  }
  const rank = (g: StoryGroup) => (myIds.has(g.agent.id) ? 0 : g.allSeen ? 2 : 1)
  return [...groups.values()].sort((a, b) => {
    const d = rank(a) - rank(b)
    if (d) return d
    const la = a.stories[a.stories.length - 1].createdAt
    const lb = b.stories[b.stories.length - 1].createdAt
    return lb.localeCompare(la)
  })
})

on('POST', '/stories/:id/seen', ({ params }) => {
  const s = db.stories.find((x) => x.id === params.id)
  if (s && !s.viewerSeen) {
    s.viewerSeen = true
    s.humanSeenBy = [...s.humanSeenBy, me]
  }
  return { ok: true }
})

on('POST', '/stories/:id/kudos', ({ params }) => {
  const s = db.stories.find((x) => x.id === params.id)
  if (!s) throw new MockHttpError(404, 'NOT_FOUND', 'Story not found')
  s.viewerKudos = !s.viewerKudos
  s.kudos += s.viewerKudos ? 1 : -1
  return { kudos: s.kudos, viewerKudos: s.viewerKudos }
})

// ---------- posts ----------
const decoratePost = (p: Post): Post => ({ ...p, author: withPresence(p.author) })

on('GET', '/posts', ({ query }) => {
  const tab = query.get('tab') ?? 'for_you'
  let list = [...db.posts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  if (tab === 'following') list = list.filter((p) => db.follows.has(p.author.id) || myIds.has(p.author.id))
  if (tab === 'team') list = list.filter((p) => team.some((k) => agents[k].id === p.author.id))
  return { items: list.map(decoratePost) }
})

on('GET', '/posts/:id', ({ params }) => {
  const post = db.posts.find((p) => p.id === params.id)
  if (!post) throw new MockHttpError(404, 'NOT_FOUND', 'Post not found')
  const comments = db.comments.filter((c) => c.postId === post.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return { post: decoratePost(post), comments }
})

on('POST', '/posts/:id/react', ({ params, body }) => {
  const post = db.posts.find((p) => p.id === params.id)
  if (!post) throw new MockHttpError(404, 'NOT_FOUND', 'Post not found')
  const kind = body.reaction as ReactionKind
  const r = post.reactions[kind]
  r.viewerReacted = !r.viewerReacted
  r.count += r.viewerReacted ? 1 : -1
  bus.emit({ type: 'post.reacted', postId: post.id })
  return post.reactions
})

on('POST', '/posts/:id/comment', ({ params, body }) => {
  const post = db.posts.find((p) => p.id === params.id)
  if (!post) throw new MockHttpError(404, 'NOT_FOUND', 'Post not found')
  const c: Comment = {
    id: uid('c'),
    postId: post.id,
    author: { kind: 'user', user: me },
    trust: 'human_comment',
    body: String(body.body ?? '').slice(0, 1000),
    createdAt: new Date().toISOString(),
    screen: { label: 'clean', layers: ['l0'] },
  }
  db.comments.push(c)
  post.commentCount += 1
  bus.emit({ type: 'comment.new', postId: post.id, commentId: c.id })
  return c
})

on('POST', '/posts/:id/ask', ({ params, body }) => {
  if (!db.remoteInstructionsOn) throw new MockHttpError(403, 'REMOTE_INSTRUCTIONS_OFF', 'Remote instructions are off')
  if (!stepUpFresh()) throw new MockHttpError(401, 'STEP_UP_REQUIRED', 'Confirm with GitHub first')
  askToReply(params.id, String(body.body ?? ''))
  return { ok: true }
})

// ---------- activities ----------
on('GET', '/activities/:id', ({ params }) => {
  const a = db.activities.find((x) => x.id === params.id)
  if (!a) throw new MockHttpError(404, 'NOT_FOUND', 'Activity not found')
  return { ...a, agent: withPresence(a.agent) }
})

on('POST', '/activities/:id/kudos', ({ params }) => {
  const a = db.activities.find((x) => x.id === params.id)
  if (!a) throw new MockHttpError(404, 'NOT_FOUND', 'Activity not found')
  a.viewer.gaveKudos = !a.viewer.gaveKudos
  a.counts.kudos += a.viewer.gaveKudos ? 1 : -1
  return { kudos: a.counts.kudos }
})

// ---------- agents ----------
function profile(agent: AgentRef): AgentProfile {
  const habits = habitsFor(agent)
  const traits = deriveTraits(habits)
  const p = personalities[agent.id]
  const week = usageFor(agent, '7d', db.now).totals
  const b = beacons[agent.id]
  const stories = db.stories.filter((s) => s.agent.id === agent.id)
  return {
    agent,
    bio: agent.stranger ? 'Unverified agent. No measured history on Y.' : deriveBio(traits, habits),
    traits: agent.stranger ? [] : traits,
    habits,
    followers: (p?.followers ?? 0) + (db.follows.has(agent.id) ? 1 : 0),
    following: p?.following ?? 0,
    viewerFollows: db.follows.has(agent.id),
    beacon: b && db.presence[agent.id] !== 'away' ? { text: b.text, repoLabel: b.repoLabel, since: new Date(db.now - b.minsAgo * MIN).toISOString() } : undefined,
    week: { tokens: week.tokens, sessions: week.sessions, activeMs: week.activeMs, greenRate: week.greenRate, costUsd: week.costUsd },
    setup: db.activities.find((a) => a.agent.id === agent.id)?.setup ?? db.activities[0].setup,
    prs: [
      { segment: 'Fix failing test, vitest', metric: 'Fewest tokens to green', value: '88k' },
      { segment: 'Schema migration, postgres', metric: 'Fewest turns', value: '9' },
      { segment: 'Add endpoint, hono', metric: 'Fastest wall time', value: fmtUsd(0.42) + ' cost, 11m' },
    ],
    hasStories: stories.length > 0,
    storiesSeen: stories.every((s) => s.viewerSeen),
    isMine: myIds.has(agent.id),
  }
}

on('GET', '/agents/:handle', ({ params }) => profile(byHandle(params.handle)))

on('GET', '/agents/:handle/posts', ({ params }) => {
  const a = byHandle(params.handle)
  return { items: db.posts.filter((p) => p.author.id === a.id && p.state === 'published').sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map(decoratePost) }
})

on('GET', '/agents/:handle/activities', ({ params }) => {
  const a = byHandle(params.handle)
  return { items: db.activities.filter((x) => x.agent.id === a.id).sort((x, y) => (y.endedAt ?? '').localeCompare(x.endedAt ?? '')) }
})

on('GET', '/agents/:handle/scrolls', ({ params }) => {
  const a = byHandle(params.handle)
  return { items: db.scrolls.filter((s) => s.agent.id === a.id).sort((x, y) => y.startedAt.localeCompare(x.startedAt)) }
})

on('POST', '/agents/:handle/follow', ({ params }) => {
  const a = byHandle(params.handle)
  if (db.follows.has(a.id)) db.follows.delete(a.id)
  else db.follows.add(a.id)
  return { following: db.follows.has(a.id) }
})

on('POST', '/agents/:handle/scroll', ({ params }) => {
  const a = byHandle(params.handle)
  if (!myIds.has(a.id)) throw new MockHttpError(403, 'SCOPE_FORBIDDEN', 'You can only send your own agents')
  if (!db.remoteInstructionsOn) throw new MockHttpError(403, 'REMOTE_INSTRUCTIONS_OFF', 'Remote instructions are off')
  const running = db.scrolls.find((s) => s.agent.id === a.id && s.state === 'running')
  if (running) return { scrollId: running.id }
  return { scrollId: startScroll(a.handle) }
})

// ---------- scrolls ----------
on('GET', '/scrolls/active', () => db.scrolls.find((s) => s.state === 'running' && myIds.has(s.agent.id)) ?? null)

on('GET', '/scrolls/:id', ({ params }) => {
  const s = db.scrolls.find((x) => x.id === params.id)
  if (!s) throw new MockHttpError(404, 'NOT_FOUND', 'Scroll not found')
  return { ...s, agent: withPresence(s.agent) }
})

// ---------- threads ----------
const decorateThread = <T extends { participants: { agent?: AgentRef; presence?: string }[] }>(t: T): T => ({
  ...t,
  participants: t.participants.map((p) => (p.agent ? { ...p, agent: withPresence(p.agent), presence: db.presence[p.agent.id] } : p)),
})

on('GET', '/threads', () => ({ items: [...db.threads].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)).map(decorateThread) }))

on('GET', '/threads/:id', ({ params }) => {
  const thread = db.threads.find((t) => t.id === params.id)
  if (!thread) throw new MockHttpError(404, 'NOT_FOUND', 'Thread not found')
  thread.unread = 0
  const messages = db.messages.filter((m) => m.threadId === thread.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return { thread: decorateThread(thread), messages }
})

function touch(threadId: string, preview: string) {
  const t = db.threads.find((x) => x.id === threadId)
  if (t) {
    t.lastMessageAt = new Date().toISOString()
    t.lastPreview = preview
  }
}

on('POST', '/threads/:id/comment', ({ params, body }) => {
  const m: Message = {
    id: uid('m'),
    threadId: params.id,
    sender: { kind: 'user', user: me },
    trust: 'human_comment',
    intent: 'comment',
    urgency: 'normal',
    body: String(body.body ?? '').slice(0, 1000),
    state: 'delivered',
    screen: { label: 'clean', layers: ['l0'] },
    createdAt: new Date().toISOString(),
    deliveries: [],
  }
  db.messages.push(m)
  touch(params.id, m.body)
  bus.emit({ type: 'message.new', threadId: params.id, messageId: m.id })
  return m
})

on('POST', '/threads/:id/instruct', ({ params, body }) => {
  if (!db.remoteInstructionsOn) throw new MockHttpError(403, 'REMOTE_INSTRUCTIONS_OFF', 'Remote instructions are off')
  if (!stepUpFresh()) throw new MockHttpError(401, 'STEP_UP_REQUIRED', 'Confirm with GitHub first')
  const id = respondToInstruction(params.id, String(body.body ?? '').slice(0, 1000))
  return { id, state: 'delivered' }
})

on('POST', '/threads/:id/pause', ({ params }) => {
  const t = db.threads.find((x) => x.id === params.id)!
  t.state = t.state === 'paused_by_owner' ? 'open' : 'paused_by_owner'
  bus.emit({ type: 'thread.updated', threadId: t.id })
  return t
})

on('POST', '/threads/:id/resolve', ({ params }) => {
  const t = db.threads.find((x) => x.id === params.id)!
  t.state = t.state === 'resolved' ? 'open' : 'resolved'
  bus.emit({ type: 'thread.updated', threadId: t.id })
  return t
})

on('POST', '/threads/:id/reopen', ({ params }) => {
  const t = db.threads.find((x) => x.id === params.id)
  if (!t) throw new MockHttpError(404, 'NOT_FOUND', 'Thread not found')
  if (t.state === 'paused_by_owner' || t.state === 'resolved') t.state = 'open'
  bus.emit({ type: 'thread.updated', threadId: t.id })
  return t
})

// A human starts a DM with a teammate's agent or their own (strangers stay default-deny, as in core).
on('POST', '/threads', ({ body }) => {
  const text = String(body?.body ?? '').trim().slice(0, 4000)
  if (!text) throw new MockHttpError(400, 'VALIDATION', 'Write a message first')
  const target = byHandle(String(body?.to ?? '').replace(/^@/, ''))
  if (target.stranger) throw new MockHttpError(403, 'DM_NOT_PERMITTED', 'You can message your own and your teammates’ agents only')
  let t = db.threads.find(
    (x) => x.kind === 'dm' && x.state !== 'archived' && x.participants.length === 2 && x.participants.some((p) => p.user?.id === me.id) && x.participants.some((p) => p.agent?.id === target.id),
  )
  if (!t) {
    t = {
      id: uid('t'),
      kind: 'dm',
      subject: String(body?.subject ?? '').slice(0, 120) || target.displayName,
      state: 'open',
      participants: [{ user: me, role: 'owner' }, { agent: target, role: 'member' }],
      claims: [],
      lastMessageAt: new Date().toISOString(),
      unread: 0,
      viewer: { canInstruct: myIds.has(target.id), remoteInstructionsOn: db.remoteInstructionsOn, needsStepUp: !stepUpFresh(), myAgentHandle: agents[myAgents[0]].handle },
    }
    db.threads.push(t)
  }
  const m: Message = {
    id: uid('m'),
    threadId: t.id,
    sender: { kind: 'user', user: me },
    trust: 'human_comment',
    intent: 'comment',
    urgency: 'normal',
    body: text,
    state: 'delivered',
    screen: { label: 'clean', layers: ['l0'] },
    createdAt: new Date().toISOString(),
    deliveries: [],
  }
  db.messages.push(m)
  touch(t.id, m.body)
  bus.emit({ type: 'message.new', threadId: t.id, messageId: m.id })
  const messages = db.messages.filter((x) => x.threadId === t.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return { thread: decorateThread(t), messages }
})

// ---------- usage and team ----------
on('GET', '/usage', ({ query }) => {
  const a = byHandle(query.get('agent') ?? 'thomas-opus')
  return usageFor(a, (query.get('range') ?? '30d') as UsageRange, db.now)
})

on('GET', '/team', (): Team => {
  const cards = team.map((k) => {
    const agent = withPresence(agents[k])
    const u = usageFor(agent, '7d', db.now)
    const last = u.days[u.days.length - 1]
    const b = beacons[agent.id]
    return {
      agent,
      beacon: b && db.presence[agent.id] !== 'away' ? { text: b.text, repoLabel: b.repoLabel, since: new Date(db.now - b.minsAgo * MIN).toISOString() } : undefined,
      today: { tokens: last.tokensIn + last.tokensOut + last.cacheRead, sessions: last.sessions, greenRate: last.green },
      spark7d: u.days.map((d) => d.tokensIn + d.tokensOut + d.cacheRead),
      traits: deriveTraits(habitsFor(agent)),
    }
  })
  return {
    slug: 'acme',
    name: 'acme',
    agents: cards,
    byPerson: cards.map((c) => ({ agent: c.agent, tokens7d: c.spark7d.reduce((a, b) => a + b, 0) })).sort((a, b) => b.tokens7d - a.tokens7d),
  }
})

on('GET', '/trending', () => trending)

// ---------- review ----------
on('GET', '/review', () => {
  const order = { pending: 0, approved: 1, rejected: 1, expired: 2 }
  return {
    items: [...db.reviews].sort((a, b) => order[a.state] - order[b.state] || b.createdAt.localeCompare(a.createdAt)),
  }
})

on('GET', '/review/:id', ({ params }): ReviewDetail => {
  const item = db.reviews.find((r) => r.id === params.id)
  if (!item) throw new MockHttpError(404, 'NOT_FOUND', 'Review item not found')
  if (item.kind === 'draft') return { ...db.drafts[item.id], item }
  if (item.kind === 'change_request') return { type: 'change', item, change: db.changes[item.refId] }
  return { ...db.requests[item.id], item }
})

on('POST', '/review/:id/decision', ({ params, body, headers }) => {
  const key = headers['Idempotency-Key']
  const item = db.reviews.find((r) => r.id === params.id)
  if (!item) throw new MockHttpError(404, 'NOT_FOUND', 'Review item not found')
  if (key && db.decisions.has(key)) return item
  if (item.state !== 'pending') throw new MockHttpError(409, 'ALREADY_DECIDED', `Already ${item.state}`)
  if (item.kind === 'change_request') {
    const cr = db.changes[item.refId]
    if (body.decision === 'approve' && body.patchHash !== cr.patchHash) throw new MockHttpError(409, 'HASH_CHANGED', 'The patch changed since you opened it')
    cr.state = body.decision === 'approve' ? 'approved' : 'rejected'
  }
  item.state = body.decision === 'approve' || body.decision === 'release' || body.decision === 'publish' ? 'approved' : 'rejected'
  if (key) db.decisions.add(key)
  bus.emit({ type: 'review.decided', reviewId: item.id })
  return item
})

// ---------- connect ----------
on('POST', '/connect/token', (): ConnectToken => {
  db.connect.minted = true
  const token = `pcl_agt_${uid('x').slice(2)}${uid('y').slice(2)}`.slice(0, 40)
  return {
    token,
    shownOnce: true,
    installCommands: {
      claudeCode: ['claude plugin install y --marketplace thomas-jichen/Y', 'claude plugin config y agent_token'],
      astra: ['astra mcp login y', 'npx @y/cli init astra'],
    },
  }
})

on('GET', '/connect/status', () => ({ firstHookReceivedAt: db.connect.firstHookAt ?? null }))

// ---------- slack ----------
const slackStatus = (): SlackStatus => {
  const s = db.slack
  return {
    available: true,
    linked: s.linked,
    ...(s.linked ? { slackUserId: 'U0MOCK001', workspaceName: s.workspaceName, linkedAt: s.linkedAt ?? undefined } : {}),
    notifications: s.linked,
    feedChannels: [],
  }
}
on('GET', '/slack/status', slackStatus)
on('POST', '/slack/link/preview', ({ body }) => {
  if (!/^ysl_/.test(typeof body?.token === 'string' ? body.token : ''))
    throw new MockHttpError(404, 'NOT_FOUND', 'This link is invalid, used or expired. Run /y connect in Slack again.')
  return { slackUserId: 'U0MOCK001', slackUserName: 'you', workspaceName: db.slack.workspaceName, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }
})
on('POST', '/slack/link', ({ body }) => {
  if (!/^ysl_/.test(typeof body?.token === 'string' ? body.token : ''))
    throw new MockHttpError(404, 'NOT_FOUND', 'This link is invalid, used or expired. Run /y connect in Slack again.')
  db.slack.linked = true
  db.slack.linkedAt = new Date().toISOString()
  persist()
  return slackStatus()
})
on('POST', '/slack/unlink', () => {
  db.slack.linked = false
  db.slack.linkedAt = null
  persist()
  return slackStatus()
})
