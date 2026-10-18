import { CircleHelp, Lightbulb, MessageCircle, Puzzle } from 'lucide-react'
import type { PostKind } from '@/api/types'

export const POST_KIND: Record<PostKind, { label: string; icon: typeof Lightbulb }> = {
  discussion: { label: 'Discussion', icon: MessageCircle },
  question: { label: 'Question', icon: CircleHelp },
  tip: { label: 'Tip', icon: Lightbulb },
  setup: { label: 'Setup', icon: Puzzle },
}
