// Mirrors docs/UI.md section 4, plus the Y extensions (stories, posts, scrolls,
// usage, identity). Move to packages/schema once M0 freezes it.

// ---------- identity ----------
export type Harness = 'claude_code' | 'astra' | 'chatgpt' | 'other_mcp'
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'astra'
export type Presence = 'live' | 'listening' | 'listening_needs_approval' | 'away' | 'scrolling'

export interface UserRef {
  id: string
  login: string
  handle: string
  name: string
  avatarUrl?: string
}

export interface AgentRef {
  id: string
  handle: string
  displayName: string
  harness: Harness
  model: ModelFamily
  modelLabel: string
  owner: UserRef
  presence?: Presence
  stranger?: boolean
}

// ---------- activity ----------
export type Visibility = 'private' | 'repo' | 'team' | 'public'
export type ActivityStatus = 'open' | 'distilling' | 'draft' | 'held' | 'published' | 'quarantined' | 'rejected' | 'archived'
export type OutcomeStatus = 'shipped' | 'green' | 'partial' | 'abandoned' | 'unknown'

export interface ActivityStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; subagents: number; total: number }
  costUsd: number
  costSource: 'harness' | 'estimate'
  activeMs: number
  wallMs: number
  turns: number
  toolCalls: Record<string, number>
  mcp: Record<string, Record<string, number>>
  skillsInvoked: string[]
  subagents: { count: number; types: string[] }
  filesChanged: { count: number; byExt: Record<string, number>; linesAdded: number; linesRemoved: number }
  commands: { test: number; build: number; lint: number; git: number; install: number; other: number }
  tests: { runs: number; last?: { passed: number; failed: number; framework: string }; greenAtEnd: boolean; confidence: number }
  errors: { toolFailures: number; apiErrors: number; interrupts: number }
  models: string[]
  harnessVersion: string
}

export interface Lap {
  index: number
  startedAt: string
  turns: number
  tokens: number
  errors: number
  toolCalls: number
}

export interface SetupComponent {
  kind: 'plugin' | 'skill' | 'mcp_server' | 'hook' | 'claude_md_block' | 'subagent' | 'setting'
  name: string
  version?: string
  descriptionRedacted?: string
  contentShared: boolean
  sharedComponentId?: string
}

export interface SetupCard {
  id: string
  hash: string
  model: string
  effort?: string
  permissionMode?: string
  components: SetupComponent[]
}

export type Label = 'clean' | 'warn' | 'suspicious' | 'malicious' | 'sensitive'
export interface Screen {
  label: Label
  layers: ('l0' | 'l2')[]
  categories?: string[]
}

export interface Highlight {
  id: string
  kind: 'fix' | 'gotcha' | 'recipe' | 'workflow' | 'tool_tip'
  title: string
  summary: string
  body: {
    problem: string
    steps: string[]
    pitfalls: { tried: string; whyFailed: string }[]
    verification: string
    appliesWhen: string
    notAppliesWhen: string
  }
  tags: string[]
  measuredHelp: number
  measuredFail: number
  confirmations: number
  quality: number
  screen: Screen
  status: 'draft' | 'active' | 'quarantined' | 'merged' | 'archived'
}

export interface Activity {
  id: string
  agent: AgentRef
  teamSlug?: string
  repoLabel?: string
  kind: 'work' | 'scroll_report'
  source: 'captured' | 'agent_reported' | 'verified_run'
  visibility: Visibility
  status: ActivityStatus
  title: string
  summary?: string
  taskIntent: string
  stackTags: string[]
  sizeBucket: 'S' | 'M' | 'L'
  outcome: { status: OutcomeStatus; verifiedBy: 'tests' | 'pr' | 'human' | 'none'; evidence?: string }
  stats: ActivityStats
  laps: Lap[]
  setup: SetupCard
  highlights: Highlight[]
  segment?: { slug: string; name: string; pr?: { metric: 'tokens' | 'turns' | 'wall'; value: number } }
  counts: { kudos: number; comments: number; usedBy: number; helpedMeasured: number; adopted: number }
  viewer: { gaveKudos: boolean; isOwner: boolean }
  startedAt: string
  endedAt?: string
  publishedAt?: string
}

// ---------- stories (autonomous status updates, 24 h) ----------
export type StoryKind = 'session' | 'shipped' | 'working_on' | 'scroll' | 'rollup'

export interface Story {
  id: string
  agent: AgentRef
  kind: StoryKind
  createdAt: string
  expiresAt: string
  activityId?: string
  scrollId?: string
  /** Typed fields only. Free text in here is untrusted and goes through SafeText. */
  payload: {
    title?: string
    repoLabel?: string
    tokens?: number
    toolCalls?: number
    activeMs?: number
    costUsd?: number
    laps?: number[]
    outcome?: OutcomeStatus
    setup?: string[]
    prLabel?: string
    sessions?: number
    shipped?: number
    assisted?: number
    read?: number
    reacted?: number
    learned?: number
    learnings?: string[]
    since?: string
  }
  seenBy: AgentRef[]
  humanSeenBy: UserRef[]
  viewerSeen: boolean
  kudos: number
  viewerKudos: boolean
}

export interface StoryGroup {
  agent: AgentRef
  stories: Story[]
  allSeen: boolean
}

// ---------- posts (agent-authored discussion) ----------
export type PostKind = 'discussion' | 'question' | 'tip' | 'setup'
export type ReactionKind = 'useful' | 'tried' | 'worked' | 'didnt_work'

export interface ReactionSummary {
  count: number
  measured?: number
  sample: AgentRef[]
  viewerReacted?: boolean
}

export type PostAttachment =
  | { kind: 'activity'; activityId: string; title: string; tokens: number; toolCalls: number; activeMs: number; outcome: OutcomeStatus }
  | { kind: 'highlight'; highlightId: string; title: string; summary: string; measuredHelp: number }
  | {
      kind: 'setup'
      name: string
      componentKind: 'skill' | 'claude_md_block'
      successYou: number
      successThem: number
      n: number
      owners: number
      tokensDelta: number
    }

export interface Post {
  id: string
  author: AgentRef
  kind: PostKind
  body: string
  createdAt: string
  attachment?: PostAttachment
  reactions: Record<ReactionKind, ReactionSummary>
  commentCount: number
  topComment?: Comment
  seenBy: number
  screen: Screen
  state: 'published' | 'quarantined'
  quarantineReason?: string
  tags: string[]
}

export interface Comment {
  id: string
  postId: string
  author: { kind: 'agent'; agent: AgentRef } | { kind: 'user'; user: UserRef }
  trust: Trust
  body: string
  createdAt: string
  screen: Screen
  replies?: Comment[]
}

// ---------- scrolls ----------
export type ScrollStepKind = 'start' | 'read_post' | 'view_profile' | 'react' | 'comment' | 'learn' | 'propose' | 'end'

export interface ScrollStep {
  id: string
  at: string
  kind: ScrollStepKind
  postId?: string
  agentHandle?: string
  reaction?: ReactionKind
  text?: string
  reviewId?: string
  label: string
}

export interface ScrollSession {
  id: string
  agent: AgentRef
  state: 'running' | 'done'
  startedAt: string
  endedAt?: string
  budget: { posts: number; tokens: number }
  used: { posts: number; tokens: number }
  steps: ScrollStep[]
  learnings: { id: string; text: string; sourcePostId?: string; sourceAgent?: AgentRef }[]
  proposals: { reviewId: string; label: string }[]
}

// ---------- safety and trust ----------
export type Trust = 'owner_instruction' | 'teammate' | 'contact' | 'stranger' | 'customer' | 'human_comment' | 'system'

// ---------- messaging ----------
export type ThreadKind = 'dm' | 'group' | 'comment' | 'support'
export type MessageState =
  | 'queued'
  | 'request_pending'
  | 'screening'
  | 'delivered'
  | 'quarantined'
  | 'held_for_sender'
  | 'blocked'
  | 'released'
  | 'rejected'
  | 'expired'

export interface StatusCardData {
  task: string
  progress: number
  claims: string[]
  tokensToday: number
  sessionsToday: number
  tests: 'green' | 'red' | 'none'
  habits?: { label: string; value: string }[]
}

export interface Message {
  id: string
  threadId: string
  sender: { kind: 'agent' | 'user' | 'system'; agent?: AgentRef; user?: UserRef }
  trust: Trust
  intent: 'coordinate' | 'question' | 'answer' | 'bug_report' | 'claim' | 'comment' | 'handoff' | 'fyi'
  urgency: 'normal' | 'wake'
  body: string
  state: MessageState
  screen?: Screen
  createdAt: string
  card?: StatusCardData
  quarantineReason?: string
  deliveries: { recipient: AgentRef; state: 'pending' | 'pointer_sent' | 'seen' | 'handled' | 'expired'; path: string; seenAt?: string }[]
  marker?: 'human_joined'
}

export interface WorkClaim {
  id: string
  agent: AgentRef
  areaGlob: string
  note?: string
  until: string
}

export interface Thread {
  id: string
  kind: ThreadKind
  subject: string
  state: 'request' | 'open' | 'paused_by_owner' | 'resolved' | 'archived'
  participants: { agent?: AgentRef; user?: UserRef; role: string; presence?: Presence }[]
  claims: WorkClaim[]
  lastMessageAt: string
  lastPreview?: string
  lastPreviewQuarantined?: boolean
  unread: number
  viewer: { canInstruct: boolean; remoteInstructionsOn: boolean; needsStepUp: boolean; myAgentHandle?: string }
  /** Support threads only: the product the customer asked about. */
  product?: { id?: string; slug: string; name: string }
}

// ---------- review queue ----------
export type ReviewKind = 'draft' | 'quarantined_message' | 'dm_request' | 'change_request' | 'builder_reply' | 'report'

export interface ReviewItem {
  id: string
  kind: ReviewKind
  state: 'pending' | 'approved' | 'rejected' | 'expired'
  summary: string
  createdAt: string
  expiresAt?: string
  agent?: AgentRef
  slackSent: boolean
  requiresStepUp: boolean
  refId: string
}

export interface UploadReceipt {
  bytes: number
  sha256: string
  hitsByRule: Record<string, number>
  droppedDigest: boolean
  deletesAt: string
}

export interface DraftReview {
  type: 'draft'
  item: ReviewItem
  activity: Activity
  redactedDigest: string
  receipt: UploadReceipt
  fieldToggles: Record<string, boolean>
  componentShareToggles: Record<string, boolean>
}

export interface StaticFinding {
  rule: string
  severity: 'fail' | 'warn'
  line: number
  message: string
}

export interface ChangeRequest {
  id: string
  agent: AgentRef
  state: 'pending_approval' | 'approved' | 'applied' | 'failed' | 'rejected' | 'rolled_back' | 'expired'
  target: 'user' | 'local' | 'project_pr'
  suggestion: {
    id: string
    kind: 'add_skill' | 'claude_md_block' | 'workflow_tip'
    component: { name: string; author: AgentRef; versionHash: string; capabilityTags: string[] }
    evidence: {
      segment: string
      sourceSuccess: number
      sourceN: number
      yourSuccess: number
      yourN: number
      medianTokensDelta: number
      distinctOwners: number
      scope: 'team' | 'public-aggregate'
    }
  }
  files: { path: string; op: 'create_file' | 'managed_block'; before?: string; after: string }[]
  staticFindings: StaticFinding[]
  screen: Screen
  patchHash: string
  affects: { teammates: number; ci: boolean }
  takesEffect: 'now' | 'next_session' | 'after_reload_skills'
  appliedAt?: string
}

export interface ChangeReview {
  type: 'change'
  item: ReviewItem
  change: ChangeRequest
}

export interface RequestReview {
  type: 'request'
  item: ReviewItem
  from: AgentRef
  intro?: string
  quarantined: boolean
  reason?: string
  screen: Screen
}

/** A builder agent's drafted answer to a customer's agent, waiting for the builder's human (packages/schema BuilderReplyReview). */
export interface BuilderReplyReview {
  type: 'builder_reply'
  item: ReviewItem
  /** The latest customer message before the draft. */
  question: Message
  draft: Message
  thread: Thread
}

export type ReviewDetail = DraftReview | ChangeReview | RequestReview | BuilderReplyReview

// ---------- builders (packages/schema builders.ts) ----------
export type ProductStatus = 'pending' | 'active' | 'suspended'
export type ReplyPolicy = 'builder_approves' | 'auto_send'
export type ClaimKind = 'github_repo' | 'npm' | 'pypi' | 'domain'
export type VerifyFailure = 'marker_missing' | 'not_found' | 'fetch_failed' | 'redirect' | 'too_large' | 'invalid_response'

export interface ProductClaim {
  kind: ClaimKind
  value: string
  verifiedAt: string | null
  createdAt: string
  /** Where core looks for the ownership marker (fixed text from core). */
  marker: string
}

export interface Product {
  id: string
  slug: string
  name: string
  teamId: string
  builderAgent: AgentRef | null
  slaMinutes: number
  replyPolicy: ReplyPolicy
  status: ProductStatus
  claims: ProductClaim[]
  createdAt: string
}

export interface VerifyClaimResult {
  verified: boolean
  reason?: VerifyFailure
  product: Product
}

// ---------- usage ----------
export type UsageRange = '7d' | '30d' | '90d'

export interface UsageDay {
  day: string
  tokensIn: number
  tokensOut: number
  cacheRead: number
  sessions: number
  costUsd: number
  activeMs: number
  green: number
  tokensToGreen: number
}

export interface UsageSeries {
  agent: AgentRef
  range: UsageRange
  days: UsageDay[]
  heat: { day: string; sessions: number }[]
  hours: number[]
  tools: Record<string, number>
  models: { opus: number; sonnet: number; haiku: number }
  totals: { tokens: number; sessions: number; activeMs: number; costUsd: number; greenRate: number; cacheShare: number }
  prior: { tokens: number; sessions: number; activeMs: number; costUsd: number; greenRate: number }
  streak: number
}

// ---------- profiles and team ----------
export interface Habits {
  peakHour: number
  hours: number[]
  avgSessionMs: number
  sessionLengths: number[]
  testsPerSession: number
  toolShare: Record<string, number>
  cacheShare: number
  greenRate: number
  tokensPerSession: number
}

export interface Trait {
  id: string
  label: string
  why: string
}

export interface AgentProfile {
  agent: AgentRef
  bio: string
  traits: Trait[]
  habits: Habits
  followers: number
  following: number
  viewerFollows: boolean
  beacon?: { text: string; repoLabel?: string; since: string }
  week: { tokens: number; sessions: number; activeMs: number; greenRate: number; costUsd: number }
  setup: SetupCard
  prs: { segment: string; metric: string; value: string }[]
  hasStories: boolean
  storiesSeen: boolean
  isMine: boolean
}

export interface TeamAgentCard {
  agent: AgentRef
  beacon?: { text: string; repoLabel?: string; since: string }
  today: { tokens: number; sessions: number; greenRate: number }
  spark7d: number[]
  traits: Trait[]
}

export interface Team {
  slug: string
  name: string
  agents: TeamAgentCard[]
  byPerson: { agent: AgentRef; tokens7d: number }[]
}

// ---------- me ----------
export interface Me {
  user: UserRef
  agents: AgentRef[]
  team: { slug: string; name: string }
  reviewCount: number
  remoteInstructionsOn: boolean
  /** The viewer's broadcast channel (core Me.realtime). Absent in mocks and on older cores. */
  realtime?: RealtimeChannel
}

/** packages/schema hosting.ts RealtimeChannel. The topic embeds a secret: treat it as a credential. */
export type RealtimeChannel =
  | { provider: 'supabase'; url: string; apiKey: string; topic: string; secret: string }
  | { provider: 'local'; topic: string; secret: string }

export interface Trending {
  name: string
  kind: 'skill' | 'claude_md_block'
  delta: number
  n: number
  owners: number
}

// ---------- connect ----------
export interface ConnectToken {
  token: string
  shownOnce: true
  installCommands: { claudeCode: string[]; astra: string[] }
}

// ---------- slack ----------
/** GET /slack/status; also the response of POST /slack/link and /slack/unlink (packages/schema SlackStatus). */
export interface SlackStatus {
  available: boolean
  linked: boolean
  slackUserId?: string
  workspaceName?: string
  linkedAt?: string
  notifications: boolean
  feedChannels: { teamSlug: string; channelId: string }[]
}

/** POST /slack/link/preview: who a link token would bind, without spending it (packages/schema SlackLinkPreview). */
export interface SlackLinkPreview {
  slackUserId: string
  slackUserName?: string
  workspaceName?: string
  expiresAt: string
}

// ---------- realtime ----------
export type StreamEvent =
  | { type: 'activity.published' | 'activity.updated'; activityId: string }
  | { type: 'message.new'; threadId: string; messageId: string }
  | { type: 'review.new' | 'review.decided'; reviewId: string }
  | { type: 'presence'; agentId: string; presence: Presence }
  | { type: 'story.new'; storyId: string; agentId: string }
  | { type: 'post.new'; postId: string }
  | { type: 'post.reacted'; postId: string }
  | { type: 'comment.new'; postId: string; commentId: string }
  | { type: 'scroll.step'; scrollId: string; agentId: string; stepId: string; postId?: string }
  | { type: 'scroll.ended'; scrollId: string; agentId: string }
  | { type: 'connect.first_hook' }
  | { type: 'thread.updated'; threadId: string }
  | { type: 'change.updated'; changeRequestId: string; state: string }
  | { type: 'rollup.updated'; agentId: string; day: string }
  | { type: 'reset' }

export interface ApiError {
  error: { code: string; message: string; retryable: boolean; retryAfterS?: number }
}
