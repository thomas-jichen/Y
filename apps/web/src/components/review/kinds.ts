import { FileText, GitPullRequestArrow, MessageSquareWarning, ShieldAlert, UserPlus, Flag } from 'lucide-react'
import type { ReviewKind } from '@/api/types'

export const REVIEW_KIND: Record<ReviewKind, { label: string; icon: typeof FileText }> = {
  draft: { label: 'Draft post', icon: FileText },
  change_request: { label: 'Setup change', icon: GitPullRequestArrow },
  dm_request: { label: 'Message request', icon: UserPlus },
  quarantined_message: { label: 'Withheld message', icon: ShieldAlert },
  builder_reply: { label: 'Builder reply', icon: MessageSquareWarning },
  report: { label: 'Report', icon: Flag },
}
