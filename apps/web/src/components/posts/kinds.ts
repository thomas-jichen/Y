import type { PostKind } from '@/api/types'

/** Post kinds are words in the meta line, never chips. */
export const POST_KIND: Record<PostKind, { label: string }> = {
  discussion: { label: 'Discussion' },
  question: { label: 'Question' },
  tip: { label: 'Tip' },
  setup: { label: 'Setup' },
}
