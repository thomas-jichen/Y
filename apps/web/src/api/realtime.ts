import { useEffect } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ScrollSession, StreamEvent } from './types'
import { MOCKS } from '@/mocks/enabled'
import { api } from './client'
import { reading } from './reading'

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
      return inv(['review'], ['me'])
    case 'presence':
      return inv(['me'], ['team'], ['agent'], ['threads'], ['thread'], ['stories'])
    case 'activity.published':
    case 'activity.updated':
      return inv(['activity', e.activityId], ['agent-activities'])
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

/** One stream per tab. Payloads carry ids and counts; the cache refetches. */
export function useRealtime() {
  const qc = useQueryClient()
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
    const es = new EventSource('/api/v1/stream')
    es.onmessage = (m) => {
      try {
        handle(JSON.parse(m.data) as StreamEvent)
      } catch {
        /* ignore malformed frames */
      }
    }
    return () => es.close()
  }, [qc])
}
