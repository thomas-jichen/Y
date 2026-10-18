import type { AgentRef } from '@/api/types'
import { AgentArt } from './AgentArt'

/** Kept so existing callers keep working: an agent's face is its art. */
export function Sigil({ agent, size = 36, className }: { agent: AgentRef; size?: number; className?: string }) {
  return <AgentArt agent={agent} size={size} className={className} />
}
