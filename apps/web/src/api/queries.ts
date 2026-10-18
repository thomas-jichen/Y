import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import type {
  Activity,
  AgentProfile,
  ClaimKind,
  Comment,
  ConnectToken,
  Harness,
  Me,
  Message,
  Post,
  Product,
  ReactionKind,
  ReplyPolicy,
  ReviewDetail,
  ReviewItem,
  ScrollSession,
  SlackLinkPreview,
  SlackStatus,
  StoryGroup,
  Team,
  Thread,
  Trending,
  UsageRange,
  UsageSeries,
  VerifyClaimResult,
} from './types'

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/me') })
export const useStories = () => useQuery({ queryKey: ['stories'], queryFn: () => api.get<StoryGroup[]>('/stories') })
export const usePosts = (tab: string) =>
  useQuery({ queryKey: ['posts', tab], queryFn: () => api.get<{ items: Post[] }>(`/posts?tab=${tab}`), placeholderData: keepPreviousData })
/** Core's feed of stats cards (real mode). Tabs map onto core tabs in api/real.ts (default: all). */
export const useFeed = (tab: string, enabled = true) =>
  useQuery({
    queryKey: ['feed', tab],
    queryFn: () => api.get<{ items: Activity[]; nextCursor?: string }>(`/feed?tab=${tab}`),
    placeholderData: keepPreviousData,
    enabled,
  })
export const usePost = (id: string) => useQuery({ queryKey: ['post', id], queryFn: () => api.get<{ post: Post; comments: Comment[] }>(`/posts/${id}`) })
export const useActivity = (id: string) => useQuery({ queryKey: ['activity', id], queryFn: () => api.get<Activity>(`/activities/${id}`) })
export const useAgent = (handle: string) => useQuery({ queryKey: ['agent', handle], queryFn: () => api.get<AgentProfile>(`/agents/${handle}`) })
export const useAgentPosts = (handle: string) =>
  useQuery({ queryKey: ['agent-posts', handle], queryFn: () => api.get<{ items: Post[] }>(`/agents/${handle}/posts`) })
export const useAgentActivities = (handle: string) =>
  useQuery({ queryKey: ['agent-activities', handle], queryFn: () => api.get<{ items: Activity[] }>(`/agents/${handle}/activities`) })
export const useAgentScrolls = (handle: string) =>
  useQuery({ queryKey: ['agent-scrolls', handle], queryFn: () => api.get<{ items: ScrollSession[] }>(`/agents/${handle}/scrolls`) })
export const useScroll = (id: string) => useQuery({ queryKey: ['scroll', id], queryFn: () => api.get<ScrollSession>(`/scrolls/${id}`) })
export const useActiveScroll = () => useQuery({ queryKey: ['scroll-active'], queryFn: () => api.get<ScrollSession | null>('/scrolls/active') })
export const useThreads = () => useQuery({ queryKey: ['threads'], queryFn: () => api.get<{ items: Thread[] }>('/threads') })
export const useThread = (id: string) =>
  useQuery({ queryKey: ['thread', id], queryFn: () => api.get<{ thread: Thread; messages: Message[] }>(`/threads/${id}`) })
export const useUsage = (handle: string | undefined, range: UsageRange) =>
  useQuery({
    queryKey: ['usage', handle, range],
    queryFn: () => api.get<UsageSeries>(`/usage?agent=${handle}&range=${range}`),
    enabled: !!handle,
    placeholderData: keepPreviousData,
  })
export const useTeam = () => useQuery({ queryKey: ['team'], queryFn: () => api.get<Team>('/team') })
export const useTrending = () => useQuery({ queryKey: ['trending'], queryFn: () => api.get<Trending[]>('/trending') })
export const useReviewItems = () => useQuery({ queryKey: ['review'], queryFn: () => api.get<{ items: ReviewItem[] }>('/review') })
export const useReviewDetail = (id: string) => useQuery({ queryKey: ['review', id], queryFn: () => api.get<ReviewDetail>(`/review/${id}`) })
export const useConnectStatus = (enabled: boolean, poll = enabled) =>
  useQuery({
    queryKey: ['connect-status'],
    queryFn: () => api.get<{ firstHookReceivedAt: string | null }>('/connect/status'),
    enabled,
    refetchInterval: poll ? 4000 : false,
  })

export const useProducts = () => useQuery({ queryKey: ['products'], queryFn: () => api.get<Product[]>('/products') })

export const useSlackStatus = () => useQuery({ queryKey: ['slack', 'status'], queryFn: () => api.get<SlackStatus>('/slack/status') })

// ---------- mutations ----------
export function useReact(postId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (reaction: ReactionKind) => api.post(`/posts/${postId}/react`, { reaction }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['posts'] })
      qc.invalidateQueries({ queryKey: ['post', postId] })
    },
  })
}

export function useCommentOnPost(postId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: string) => api.post<Comment>(`/posts/${postId}/comment`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['post', postId] })
      qc.invalidateQueries({ queryKey: ['posts'] })
    },
  })
}

export function useAskOnPost(postId: string) {
  return useMutation({ mutationFn: (body: string) => api.post(`/posts/${postId}/ask`, { body }) })
}

export function useStorySeen() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/stories/${id}/seen`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stories'] }),
  })
}

export function useStoryKudos() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/stories/${id}/kudos`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stories'] }),
  })
}

export function useActivityKudos(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post(`/activities/${id}/kudos`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['activity', id] }),
  })
}

export function useFollow(handle: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post(`/agents/${handle}/follow`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent', handle] })
      qc.invalidateQueries({ queryKey: ['posts'] })
    },
  })
}

export function useSendForScroll() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (handle: string) => api.post<{ scrollId: string }>(`/agents/${handle}/scroll`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scroll-active'] }),
  })
}

export function useThreadComment(threadId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: string) => api.post<Message>(`/threads/${threadId}/comment`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['thread', threadId] })
      qc.invalidateQueries({ queryKey: ['threads'] })
    },
  })
}

export function useInstruct(threadId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: string) => api.post<{ id: string }>(`/threads/${threadId}/instruct`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['thread', threadId] }),
  })
}

export function useThreadAction(threadId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (action: 'pause' | 'resolve' | 'reopen') => api.post<Thread>(`/threads/${threadId}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['thread', threadId] })
      qc.invalidateQueries({ queryKey: ['threads'] })
    },
  })
}

/** A human starts (or continues) a direct conversation with a teammate's agent, or their own. */
export function useStartThread() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { to: string; body: string; subject?: string }) =>
      api.post<{ thread: Thread; messages: Message[] }>('/threads', { to: v.to.startsWith('@') ? v.to : `@${v.to}`, body: v.body, ...(v.subject ? { subject: v.subject } : {}) }),
    onSuccess: (d) => {
      qc.setQueryData(['thread', d.thread.id], d)
      qc.invalidateQueries({ queryKey: ['threads'] })
    },
  })
}

export function useStepUp() {
  return useMutation({ mutationFn: () => api.post('/auth/step-up') })
}

export function useRemoteInstructions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (on: boolean) => api.post<{ remoteInstructionsOn: boolean }>('/settings/remote-instructions', { on }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] })
      qc.invalidateQueries({ queryKey: ['thread'] })
      qc.invalidateQueries({ queryKey: ['threads'] })
    },
  })
}

export function useDecision(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { decision: 'approve' | 'reject' | 'release' | 'hold' | 'publish'; patchHash?: string; edits?: { body?: string }; idempotencyKey: string }) =>
      api.post<ReviewItem>(`/review/${id}/decision`, { decision: v.decision, patchHash: v.patchHash, ...(v.edits ? { edits: v.edits } : {}) }, v.idempotencyKey),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['review'] })
      qc.invalidateQueries({ queryKey: ['me'] })
    },
  })
}

/** Mint an agent token for one harness. UI harness ids; real mode maps 'astra' → core's 'codex' (api/real.ts). */
export function useMintToken() {
  return useMutation({ mutationFn: (harness: Extract<Harness, 'claude_code' | 'astra'> = 'claude_code') => api.post<ConnectToken>('/connect/token', { harness }) })
}

/** Who a link token would bind (read-only; the token is not spent). */
export const useSlackLinkPreview = (token: string | undefined) =>
  useQuery({
    queryKey: ['slack', 'linkPreview', token],
    queryFn: () => api.post<SlackLinkPreview>('/slack/link/preview', { token }),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
  })

/** Completes a Slack link from the single-use token `/y connect` sends. Only on an explicit click (never on load). */
export function useSlackLink() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (token: string) => api.post<SlackStatus>('/slack/link', { token }),
    onSuccess: (s) => qc.setQueryData(['slack', 'status'], s),
  })
}

export function useSlackUnlink() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<SlackStatus>('/slack/unlink', {}),
    onSuccess: (s) => qc.setQueryData(['slack', 'status'], s),
  })
}

// ---------- builders (team admins; members get 403) ----------
/** Every products write answers with the product; the list is patched in place. */
function useProductWrite<V>(fn: (v: V) => Promise<Product>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (p) => qc.setQueryData<Product[]>(['products'], (list) => (list?.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...(list ?? []), p])),
  })
}

export const useCreateProduct = () =>
  useProductWrite((v: { slug: string; name: string; builderAgent: string; slaMinutes?: number; replyPolicy?: ReplyPolicy }) => api.post<Product>('/products', v))

export const useUpdateProduct = (id: string) =>
  useProductWrite((v: { name?: string; builderAgent?: string | null; slaMinutes?: number; replyPolicy?: ReplyPolicy; status?: 'active' | 'suspended' }) =>
    api.patch<Product>(`/products/${id}`, v),
  )

export const useAddClaim = (id: string) => useProductWrite((v: { kind: ClaimKind; value: string }) => api.post<Product>(`/products/${id}/claims`, v))

export function useVerifyClaim(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { kind: ClaimKind; value: string }) => api.post<VerifyClaimResult>(`/products/${id}/claims/verify`, v),
    onSuccess: (r) => qc.setQueryData<Product[]>(['products'], (list) => list?.map((x) => (x.id === r.product.id ? r.product : x))),
  })
}
