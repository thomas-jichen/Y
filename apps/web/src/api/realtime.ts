import { useEffect } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { Me, ScrollSession, StreamEvent } from './types'
import { API_BASE, MOCKS, SUPABASE } from '@/lib/env'
import { api } from './client'
import { useAuth } from './auth'
import { reading } from './reading'
import { supabase } from './supabase'

function invalidate(qc: QueryClient, e: StreamEvent) {
  const inv = (...keys: unknown[][]) => keys.forEach((queryKey) => qc.invalidateQueries({ queryKey }))
  switch (e.type) {
    case 'story.new':
      return inv(['stories'], ['agent'])
    case 'post.new':
    case 'post.reacted':
      return inv(['posts'], ['post', e.postId], ['agent-posts'])
    case 'comment.new':
      return inv(['posts'], ['post', e.postId])
    case 'scroll.step':
    case 'scroll.ended':
      return inv(['scroll', e.scrollId], ['scroll-active'], ['agent-scrolls'])
    case 'message.new':
      return inv(['threads'], ['thread', e.threadId])
    case 'thread.updated':
      // instruct can flip remote instructions on; keep the composer's lock state current
      return inv(['threads'], ['thread', e.threadId], ['me'])
    case 'review.new':
    case 'review.decided':
    case 'change.updated':
      return inv(['review'], ['me'])
    case 'presence':
      return inv(['me'], ['team'], ['agent'], ['threads'], ['thread'], ['stories'])
    case 'activity.published':
    case 'activity.updated':
      return inv(['activity', e.activityId], ['agent-activities'], ['feed'])
    case 'rollup.updated':
      return inv(['feed'], ['usage'], ['agent'])
    case 'connect.first_hook':
      return inv(['connect-status'])
    case 'reset':
      reading.clear()
      return qc.invalidateQueries()
  }
}

async function track(qc: QueryClient, e: StreamEvent) {
  if (e.type === 'scroll.ended') return reading.clear()
  if (e.type !== 'scroll.step') return
  if (!e.postId) return reading.set({ ...readingNoPost(), scrollId: e.scrollId })
  const s = await qc.fetchQuery({ queryKey: ['scroll', e.scrollId], queryFn: () => api.get<ScrollSession>(`/scrolls/${e.scrollId}`), staleTime: 0 })
  reading.set({ postId: e.postId, agent: s.agent, scrollId: e.scrollId })
}
const readingNoPost = () => ({ postId: undefined, agent: undefined })

/** SSE event names core emits (`event: <type>`); EventSource only hands named events to matching listeners. */
const SSE_TYPES = ['activity.published', 'activity.updated', 'message.new', 'review.new', 'review.decided', 'change.updated', 'presence', 'rollup.updated', 'thread.updated']
const POLL_MS = 10_000

/** A broadcast or SSE frame → StreamEvent. Broadcasts are {id, type, payload}; SSE data is the flat event. */
function toEvent(raw: unknown, fallbackType?: string): StreamEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { type?: unknown; payload?: unknown }
  if (r.payload && typeof r.payload === 'object') return { ...(r.payload as object), type: r.type ?? fallbackType } as StreamEvent
  const type = r.type ?? fallbackType
  return typeof type === 'string' ? ({ ...(raw as object), type } as StreamEvent) : null
}

/**
 * Realtime, in order of preference (events only trigger refetches; payloads carry ids and counts):
 * 1. Supabase Realtime broadcast on Me.realtime.topic, when /me returns a supabase descriptor and Supabase is configured;
 * 2. SSE against a local core: EventSource(API_BASE + '/stream?token=…') with a token from POST /stream-token;
 * 3. polling every 10 s.
 */
function connectReal(qc: QueryClient, handle: (e: StreamEvent) => void): () => void {
  let stopped = false
  const cleanups: (() => void)[] = []
  const stop = () => {
    stopped = true
    cleanups.splice(0).forEach((f) => f())
  }

  const poll = () => {
    if (stopped) return
    const t = setInterval(() => void qc.invalidateQueries({ refetchType: 'active' }), POLL_MS)
    cleanups.push(() => clearInterval(t))
  }

  const sse = async (failures = 0): Promise<void> => {
    if (stopped) return
    if (failures >= 3) return poll()
    let token: string | undefined
    try {
      const r = await api.post<{ token?: string; streamToken?: string }>('/stream-token')
      token = r?.token ?? r?.streamToken
    } catch {
      token = undefined
    }
    if (stopped) return
    if (!token) return poll() // core has no stream tokens (or refused): poll instead
    const es = new EventSource(`${API_BASE}/stream?token=${encodeURIComponent(token)}`)
    let opened = false
    const onFrame = (type?: string) => (m: MessageEvent) => {
      try {
        const e = toEvent(JSON.parse(m.data), type)
        if (e) handle(e)
      } catch {
        /* ignore malformed frames */
      }
    }
    es.onmessage = onFrame()
    for (const t of SSE_TYPES) es.addEventListener(t, onFrame(t) as EventListener)
    es.onopen = () => {
      opened = true
    }
    es.onerror = () => {
      // Stream tokens are short-lived: mint a new one instead of letting EventSource retry the old URL.
      es.close()
      if (stopped) return
      const t = setTimeout(() => void sse(opened ? 0 : failures + 1), opened ? 1000 : 2000 * (failures + 1))
      cleanups.push(() => clearTimeout(t))
    }
    cleanups.push(() => es.close())
  }

  void (async () => {
    let me: Me | undefined
    try {
      me = await qc.fetchQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/me') })
    } catch {
      me = undefined
    }
    if (stopped) return
    const rt = me?.realtime
    if (rt?.provider === 'supabase' && SUPABASE) {
      try {
        const client = await supabase()!
        if (stopped) return
        const ch = client
          .channel(rt.topic, { config: { private: false } })
          .on('broadcast', { event: '*' }, (msg: { event: string; payload?: unknown }) => {
            const e = toEvent(msg.payload, msg.event)
            if (e) handle(e)
          })
          .subscribe((status) => {
            // A broadcast channel that can't join (caps, network) degrades to polling.
            if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !stopped) {
              void client.removeChannel(ch)
              poll()
            }
          })
        cleanups.push(() => void client.removeChannel(ch))
        return
      } catch {
        return poll()
      }
    }
    return sse()
  })()

  return stop
}

/** One stream per tab. Payloads carry ids and counts; the cache refetches. */
export function useRealtime() {
  const qc = useQueryClient()
  // Keyed on sign-in status, not the token: Supabase refreshes tokens hourly and the stream re-mints on reconnect.
  const { status } = useAuth()
  useEffect(() => {
    const handle = (e: StreamEvent) => {
      invalidate(qc, e)
      void track(qc, e)
    }
    if (MOCKS) {
      let off = () => {}
      void import('@/mocks/bus').then(({ bus }) => {
        off = bus.subscribe(handle)
      })
      return () => off()
    }
    if (status !== 'signed_in') return
    return connectReal(qc, handle)
  }, [qc, status])
}
