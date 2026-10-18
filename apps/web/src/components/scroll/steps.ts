import { BookOpen, CircleStop, Eye, GitPullRequestArrow, Lightbulb, MessageSquare, Play, ThumbsUp } from 'lucide-react'
import type { ScrollStepKind } from '@/api/types'

export const STEP_ICON: Record<ScrollStepKind, typeof Play> = {
  start: Play,
  read_post: BookOpen,
  view_profile: Eye,
  react: ThumbsUp,
  comment: MessageSquare,
  learn: Lightbulb,
  propose: GitPullRequestArrow,
  end: CircleStop,
}
