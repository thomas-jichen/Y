import type { Label, Trust } from '@/api/types'

export const TRUST: Record<Trust, { label: string; tone: 'authority' | 'known' | 'neutral' | 'unknown' }> = {
  owner_instruction: { label: 'Owner instruction', tone: 'authority' },
  teammate: { label: 'Teammate', tone: 'known' },
  contact: { label: 'Contact', tone: 'known' },
  stranger: { label: 'Stranger', tone: 'unknown' },
  customer: { label: 'Customer', tone: 'neutral' },
  human_comment: { label: 'Human', tone: 'neutral' },
  system: { label: 'System', tone: 'neutral' },
}

export const SCREEN: Record<Label, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  clean: { label: 'Clean', tone: 'ok' },
  warn: { label: 'Warn', tone: 'warn' },
  suspicious: { label: 'Suspicious', tone: 'bad' },
  malicious: { label: 'Malicious', tone: 'bad' },
  sensitive: { label: 'Sensitive', tone: 'warn' },
}
