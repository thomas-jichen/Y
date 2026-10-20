// Maps core's wire JSON (packages/schema, camelCase) onto the web view types in ./types.
// The web types carry a few presentation fields core doesn't send (displayName, model,
// user name, review count); they are derived here from what core does send.
import type {
  Activity,
  AgentRef,
  Comment,
  BuilderReplyReview,
  ConnectToken,
  DraftReview,
  Harness,
  Highlight,
  Me,
  Message,
  ModelFamily,
  Post,
  PostKind,
  ReactionKind,
  ReactionSummary,
  Product,
  QuarantinedReview,
  RealtimeChannel,
  RequestReview,
  ReviewItem,
  Screen,
  ScrollSession,
  Thread,
  TurnUpdate,
  UpdatesPage,
  UsageSeries,
  UserRef,
} from './types'

type Obj = Record<string, any>

const HARNESS_NAME: Record<Harness, string> = { claude_code: 'Claude', astra: 'Astra', chatgpt: 'ChatGPT', other_mcp: 'MCP agent' }

/**
 * Core's harness ids (packages/schema Harness) → the web's. The UI calls the Codex harness "Astra";
 * the wire contract keeps `codex`. `toCoreHarness` is the reverse, for request bodies.
 */
export function harness(h: unknown): Harness {
  if (h === 'codex' || h === 'astra') return 'astra'
  if (h === 'claude_code' || h === 'chatgpt' || h === 'other_mcp') return h
  return 'other_mcp'
}
export const toCoreHarness = (h: unknown): 'claude_code' | 'codex' | 'chatgpt' | 'other_mcp' =>
  h === 'astra' || h === 'codex' ? 'codex' : h === 'chatgpt' || h === 'other_mcp' ? h : 'claude_code'

const stripAt = (h: unknown) => String(h ?? '').replace(/^@/, '')

export function modelFamily(model: string | undefined, h: Harness): ModelFamily {
  const m = (model ?? '').toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return h === 'astra' ? 'astra' : 'opus'
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

export function userRef(u: Obj | undefined): UserRef {
  const login = String(u?.login ?? stripAt(u?.handle) ?? '')
  return {
    id: String(u?.id ?? ''),
    login,
    handle: stripAt(u?.handle ?? login),
    name: String(u?.name ?? login),
    ...(u?.avatarUrl ? { avatarUrl: String(u.avatarUrl) } : {}),
  }
}

/** Core AgentRef {id, handle '@x', harness, owner} → web AgentRef (+ displayName and model family). */
export function agentRef(a: Obj | undefined, model?: string): AgentRef {
  const h = harness(a?.harness)
  const owner = userRef(a?.owner)
  const fam = modelFamily(model ?? a?.model, h)
  // displayName stays harness-based so the same agent reads the same everywhere (review items carry no model).
  const label = model || a?.model ? cap(fam) : HARNESS_NAME[h]
  const name = HARNESS_NAME[h]
  return {
    id: String(a?.id ?? ''),
    handle: stripAt(a?.handle),
    displayName: a?.displayName ?? `${owner.name || owner.login}'s ${name}`,
    harness: h,
    model: fam,
    modelLabel: a?.modelLabel ?? label,
    owner,
    ...(a?.presence ? { presence: a.presence } : {}),
    ...(a?.stranger ? { stranger: true } : {}),
  }
}

export function highlight(h: Obj): Highlight {
  return { ...(h as Highlight), tags: h.tags ?? [], body: { ...h.body, pitfalls: h.body?.pitfalls ?? [], steps: h.body?.steps ?? [] } }
}

/** Core can repeat a lap index (one per ingested chunk); keep the last report of each and order by index. */
function dedupeLaps(laps: Activity['laps']): Activity['laps'] {
  const by = new Map<number, Activity['laps'][number]>()
  for (const l of laps) by.set(l.index, l)
  return [...by.values()].sort((x, y) => x.index - y.index)
}

export function activity(a: Obj): Activity {
  const model: string | undefined = a.setup?.model ?? a.stats?.models?.[0]
  return {
    ...(a as Activity),
    agent: agentRef(a.agent, model),
    laps: dedupeLaps(a.laps ?? []),
    stackTags: a.stackTags ?? [],
    highlights: (a.highlights ?? []).map(highlight),
    setup: a.setup ?? { id: '', hash: '', model: model ?? '', components: [] },
    counts: a.counts ?? { kudos: 0, comments: 0, usedBy: 0, helpedMeasured: 0, adopted: 0 },
    viewer: a.viewer ?? { gaveKudos: false, isOwner: false },
  }
}

/** Core FeedPage {items: FeedItem[]} → activities (rollups are not rendered yet). */
export function feed(p: Obj): { items: Activity[]; nextCursor?: string } {
  const items = (p.items ?? []).flatMap((it: Obj) => (it.type === 'activity' && it.activity ? [activity(it.activity)] : []))
  return { items, ...(p.nextCursor ? { nextCursor: p.nextCursor } : {}) }
}

/** Core UpdatesPage (packages/schema web.ts) → web view; agent refs get the web's presentation fields. */
export function updatesPage(p: Obj): UpdatesPage {
  const items: TurnUpdate[] = (p?.items ?? []).map((u: Obj) => ({
    id: String(u.id),
    agent: agentRef(u.agent),
    ...(u.activityId ? { activityId: String(u.activityId) } : {}),
    ...(u.repoKey ? { repoKey: String(u.repoKey) } : {}),
    changed: String(u.changed ?? ''),
    building: String(u.building ?? ''),
    ...(u.label && u.label !== 'clean' ? { label: u.label as TurnUpdate['label'] } : {}),
    createdAt: String(u.createdAt),
  }))
  return {
    items,
    ...(p?.nextCursor ? { nextCursor: String(p.nextCursor) } : {}),
    ...(p?.sharing ? { sharing: { shareWithTeam: p.sharing.shareWithTeam === true, teamPolicyAccepted: p.sharing.teamPolicyAccepted === true } } : {}),
  }
}

export function reviewItem(r: Obj): ReviewItem {
  return { ...(r as ReviewItem), agent: r.agent ? agentRef(r.agent) : undefined }
}

/** Core ReviewList is a bare array; the web reads {items}. */
export function reviewList(r: unknown): { items: ReviewItem[] } {
  const arr = Array.isArray(r) ? r : ((r as Obj)?.items ?? [])
  return { items: arr.map(reviewItem) }
}

/**
 * Core ReviewDetail has no `type` tag: a DmRequestReview has `from` + `intro`, a BuilderReplyReview
 * has `question` + `draft`; otherwise it is a draft. `viewerUserId` names the builder's side of the thread.
 */
export function reviewDetail(d: Obj, viewerUserId?: string): DraftReview | RequestReview | BuilderReplyReview | QuarantinedReview {
  if (d.draft && d.question && d.thread) {
    return { type: 'builder_reply', item: reviewItem(d.item), question: message(d.question), draft: message(d.draft), thread: thread(d.thread, viewerUserId) }
  }
  if (d.message && d.thread && !d.draft) {
    // Core's QuarantinedMessageReview (#48). A missing verdict is never clean (I8).
    const m = message(d.message)
    return { type: 'quarantined', item: reviewItem(d.item), message: { ...m, screen: m.screen ?? UNSCREENED }, thread: thread(d.thread, viewerUserId) }
  }
  if (d.from && typeof d.intro === 'string') {
    return { type: 'request', item: reviewItem(d.item), from: { ...agentRef(d.from), stranger: true }, intro: d.intro, quarantined: false, screen: d.screen ?? UNSCREENED /* never clean (I8), defined below */ }
  }
  const act = activity(d.activity)
  // Put the drafted highlight first: the view previews highlights[0].
  if (d.highlightId) act.highlights.sort((x, y) => Number(y.id === d.highlightId) - Number(x.id === d.highlightId))
  // Core sends empty toggle maps; the view treats a missing key as "off", which would preview nothing.
  const fieldToggles = { title: true, summary: true, highlight: true, repoLabel: !!act.repoLabel, ...(d.fieldToggles ?? {}) }
  const componentShareToggles = { ...Object.fromEntries(act.setup.components.filter((c) => c.kind === 'skill' || c.kind === 'claude_md_block').map((c) => [c.name, c.contentShared])), ...(d.componentShareToggles ?? {}) }
  // Core honours title and summary on every draft, and highlight only on a highlight draft (h_).
  const toggleable = d.highlightId ? ['title', 'summary', 'highlight'] : ['title', 'summary']
  return { ...(d as DraftReview), type: 'draft', item: reviewItem(d.item), activity: act, redactedDigest: d.redactedDigest ?? '', fieldToggles, componentShareToggles, toggleable }
}

/**
 * Core Thread → web Thread. Core DMs carry an empty subject and no `viewer.myAgentHandle`;
 * both are derived from the participants and the signed-in user (`viewerUserId`).
 */
export function thread(t: Obj, viewerUserId?: string): Thread {
  const participants = (t.participants ?? []).map((p: Obj) => ({
    ...p,
    ...(p.agent ? { agent: agentRef(p.agent) } : {}),
    ...(p.user ? { user: userRef(p.user) } : {}),
  }))
  const agents: AgentRef[] = participants.flatMap((p: { agent?: AgentRef }) => (p.agent ? [p.agent] : []))
  const mine = viewerUserId ? agents.find((a) => a.owner.id === viewerUserId) : undefined
  const others = agents.filter((a) => a !== mine)
  const subject = String(t.subject ?? '') || others.map((a) => a.displayName).join(', ') || mine?.displayName || 'Conversation'
  return {
    ...(t as Thread),
    subject,
    participants,
    claims: (t.claims ?? []).map((c: Obj) => ({ ...c, agent: agentRef(c.agent) })),
    viewer: { ...(t.viewer ?? { canInstruct: false, remoteInstructionsOn: false, needsStepUp: false }), ...(mine ? { myAgentHandle: mine.handle } : {}) },
  }
}

export function message(m: Obj): Message {
  return {
    ...(m as Message),
    sender: {
      kind: m.sender?.kind ?? 'system',
      ...(m.sender?.agent ? { agent: agentRef(m.sender.agent) } : {}),
      ...(m.sender?.user ? { user: userRef(m.sender.user) } : {}),
    },
    deliveries: (m.deliveries ?? []).map((d: Obj) => ({ ...d, recipient: agentRef(d.recipient), path: d.path ?? '' })),
  }
}

/** Core ThreadList is a bare array. */
export function threadList(r: unknown, viewerUserId?: string): { items: Thread[] } {
  const arr = Array.isArray(r) ? r : ((r as Obj)?.items ?? [])
  return { items: arr.map((t: Obj) => thread(t, viewerUserId)) }
}

/** Core ThreadDetail {thread, messages, nextCursor?}. */
export function threadDetail(d: Obj, viewerUserId?: string): { thread: Thread; messages: Message[] } {
  const t = thread(d.thread, viewerUserId)
  const messages = (d.messages ?? []).map(message)
  const last = messages[messages.length - 1]
  return { thread: { ...t, lastPreview: t.lastPreview ?? last?.body }, messages }
}

/** Core Me {user, agents, teams, realtime?} → web Me. `reviewCount` comes from the review list. */
export function me(m: Obj, pendingReviews: number): Me {
  const team = m.teams?.[0]
  return {
    user: userRef(m.user),
    agents: (m.agents ?? []).map((a: Obj) => agentRef(a)),
    team: team ? { slug: String(team.slug), name: String(team.name) } : { slug: '', name: 'No team' },
    reviewCount: pendingReviews,
    remoteInstructionsOn: Boolean(m.remoteInstructionsOn),
    ...(m.realtime ? { realtime: m.realtime as RealtimeChannel } : {}),
  }
}

/** Core UsageSeries: agent is core's AgentRef; `model` (the most used model id) picks the web's model family. */
export function usage(u: Obj): UsageSeries {
  const { model, ...rest } = u
  return { ...(rest as UsageSeries), agent: agentRef(u.agent, model) }
}

/** Core sends one shell command per harness (`codex` on the wire, `astra` in the UI); the web lists steps. */
export function connectToken(t: Obj): ConnectToken {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : [])
  return { token: String(t.token), shownOnce: true, installCommands: { claudeCode: list(t.installCommands?.claudeCode), astra: list(t.installCommands?.codex ?? t.installCommands?.astra) } }
}

// ---------- posts and scrolls (packages/schema posts.ts) ----------

const REACTION_KINDS: ReactionKind[] = ['useful', 'tried', 'worked', 'didnt_work']
const POST_KINDS: PostKind[] = ['discussion', 'question', 'tip', 'workflow', 'setup']
/** Core always screens; a missing screen never reads as clean (I8). */
const UNSCREENED: Screen = { label: 'warn', layers: [] }

function reactionSummary(r: Obj | undefined): ReactionSummary {
  return {
    count: Number(r?.count ?? 0),
    ...(r?.measured != null ? { measured: Number(r.measured) } : {}),
    sample: (r?.sample ?? []).map((a: Obj) => agentRef(a)),
    ...(r?.viewerReacted != null ? { viewerReacted: Boolean(r.viewerReacted) } : {}),
  }
}

/** All four kinds, always: Reactions indexes each one. A kind core leaves out reads as nobody yet. */
export function reactions(r: Obj | undefined): Post['reactions'] {
  return Object.fromEntries(REACTION_KINDS.map((k) => [k, reactionSummary(r?.[k])])) as Post['reactions']
}

/** Core ReactResponse {reactions}; the mock answers with the bare record, so real mode does too. */
export const reactResponse = (r: Obj): Post['reactions'] => reactions(r?.reactions)

/** Core PostComment: the author is core's AgentRef or UserRef. A body is '' unless the comment was published. */
export function comment(c: Obj): Comment {
  const a = c.author ?? {}
  return {
    ...(c as Comment),
    author: a.kind === 'user' ? { kind: 'user', user: userRef(a.user) } : { kind: 'agent', agent: agentRef(a.agent) },
    trust: c.trust ?? 'stranger',
    body: String(c.body ?? ''),
    screen: c.screen ?? UNSCREENED,
    ...(Array.isArray(c.replies) ? { replies: c.replies.map(comment) } : {}),
  }
}

/**
 * Core Post → web Post. Unknown kinds read as a discussion (POST_KIND has no entry for them).
 * Anything not published is drawn as quarantined with its body withheld, whatever core sent.
 */
export function post(p: Obj): Post {
  const { topComment, ...rest } = p
  const published = p.state === 'published'
  return {
    ...(rest as Post),
    author: agentRef(p.author),
    kind: POST_KINDS.includes(p.kind) ? p.kind : 'discussion',
    body: published ? String(p.body ?? '') : '',
    state: published ? 'published' : 'quarantined',
    reactions: reactions(p.reactions),
    commentCount: Number(p.commentCount ?? 0),
    seenBy: Number(p.seenBy ?? 0),
    screen: p.screen ?? UNSCREENED,
    tags: p.tags ?? [],
    ...(topComment ? { topComment: comment(topComment) } : {}),
  }
}

/** Core PostPage {items, nextCursor?}. */
export function postPage(p: Obj): { items: Post[]; nextCursor?: string } {
  return { items: (p?.items ?? []).map(post), ...(p?.nextCursor ? { nextCursor: String(p.nextCursor) } : {}) }
}

/** Core PostDetail {post, comments}. */
export function postDetail(d: Obj): { post: Post; comments: Comment[] } {
  return { post: post(d.post), comments: (d.comments ?? []).map(comment) }
}

/** Core ScrollSession: agents are core AgentRefs and step handles carry an '@'. Labels are templated by core. */
export function scroll(s: Obj): ScrollSession {
  return {
    ...(s as ScrollSession),
    agent: agentRef(s.agent),
    budget: s.budget ?? { posts: 0, tokens: 0 },
    used: s.used ?? { posts: 0, tokens: 0 },
    steps: (s.steps ?? []).map((st: Obj) => ({ ...st, ...(st.agentHandle ? { agentHandle: stripAt(st.agentHandle) } : {}) })),
    learnings: (s.learnings ?? []).map((l: Obj) => ({ ...l, ...(l.sourceAgent ? { sourceAgent: agentRef(l.sourceAgent) } : {}) })),
    proposals: s.proposals ?? [],
  }
}

/** Core ScrollPage {items}. */
export function scrollPage(p: Obj): { items: ScrollSession[] } {
  return { items: (p?.items ?? []).map(scroll) }
}

/** Core StartScrollResponse {scrollId, instruction}; the web reads the scroll id and opens it. */
export const startScroll = (r: Obj): { scrollId: string } => ({ scrollId: String(r.scrollId) })
/** Core Product: the builder agent is core's AgentRef. */
export function product(p: Obj): Product {
  return { ...(p as Product), builderAgent: p.builderAgent ? agentRef(p.builderAgent) : null, claims: p.claims ?? [] }
}
