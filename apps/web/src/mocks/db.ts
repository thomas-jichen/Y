import type {
  Activity,
  ChangeRequest,
  Comment,
  DraftReview,
  Message,
  Post,
  RequestReview,
  ReviewItem,
  ScrollSession,
  Story,
  Thread,
} from '@/api/types'
import { bus } from './bus'
import { agents } from './cast'
import { buildActivities, buildComments, buildPosts, buildReviews, buildScrolls, buildStories, buildThreads } from './fixtures'
import { resetUsageCache } from './gen'

export interface Db {
  now: number
  activities: Activity[]
  stories: Story[]
  posts: Post[]
  comments: Comment[]
  threads: Thread[]
  messages: Message[]
  reviews: ReviewItem[]
  drafts: Record<string, DraftReview>
  changes: Record<string, ChangeRequest>
  requests: Record<string, RequestReview>
  scrolls: ScrollSession[]
  follows: Set<string>
  remoteInstructionsOn: boolean
  stepUpAt?: number
  connect: { minted: boolean; firstHookAt?: string }
  presence: Record<string, string>
  decisions: Set<string>
  slack: { linked: boolean; workspaceName: string; linkedAt: string | null }
}

function build(): Db {
  const now = Date.now()
  const activities = buildActivities(now)
  const comments = buildComments(now)
  const { threads, messages } = buildThreads(now)
  const reviews = buildReviews(now, activities)
  return {
    now,
    activities,
    stories: buildStories(now, activities),
    posts: buildPosts(now, comments),
    comments,
    threads,
    messages,
    reviews: reviews.items,
    drafts: reviews.drafts,
    changes: reviews.changes,
    requests: reviews.requests,
    scrolls: buildScrolls(now),
    follows: new Set(['ag_laurence_opus', 'ag_vivan_opus', 'ag_maya_astra']),
    remoteInstructionsOn: false,
    connect: { minted: false },
    presence: Object.fromEntries(Object.values(agents).map((a) => [a.id, a.presence ?? 'away'])),
    decisions: new Set(),
    slack: { linked: false, workspaceName: 'Acme (mock)', linkedAt: null },
  }
}

// Survive a page refresh mid-demo: the mock world lives in sessionStorage until Reset.
const KEY = 'y-mock-db-v3'

function restore(): Db | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const o = JSON.parse(raw)
    const d: Db = { ...o, follows: new Set(o.follows), decisions: new Set(o.decisions) }
    // a world saved before Slack existed
    d.slack ??= { linked: false, workspaceName: 'Acme (mock)', linkedAt: null }
    // a scroll cut off by the refresh cannot resume; close it cleanly
    d.scrolls.forEach((s) => {
      if (s.state === 'running') {
        s.state = 'done'
        s.endedAt = new Date().toISOString()
        d.presence[s.agent.id] = 'away'
      }
    })
    return d
  } catch {
    return null
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
export function persist() {
  clearTimeout(timer)
  timer = setTimeout(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ ...db, follows: [...db.follows], decisions: [...db.decisions] }))
    } catch {
      /* storage can be unavailable; the demo still runs in memory */
    }
  }, 120)
}

export let db: Db = restore() ?? build()
bus.subscribe(persist)

export function resetDb() {
  resetUsageCache()
  db = build()
  clearTimeout(timer)
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
