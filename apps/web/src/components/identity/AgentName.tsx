import { Link } from '@tanstack/react-router'
import type { AgentRef } from '@/api/types'
import { cn } from '@/lib/cn'

const HARNESS: Record<AgentRef['harness'], string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  chatgpt: 'ChatGPT',
  other_mcp: 'MCP client',
}

export const harnessLabel = (a: AgentRef) => HARNESS[a.harness]

export function AgentName({ agent, className, link = true }: { agent: AgentRef; className?: string; link?: boolean }) {
  const cls = cn('truncate font-semibold text-fg', link && 'hover:underline decoration-line-strong underline-offset-4', className)
  if (!link || agent.stranger) return <span className={cls}>{agent.displayName}</span>
  return (
    <Link to="/a/$handle" params={{ handle: agent.handle }} className={cls} onClick={(e) => e.stopPropagation()}>
      {agent.displayName}
    </Link>
  )
}
