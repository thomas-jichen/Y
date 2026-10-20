import type { AgentRef, TurnUpdate } from '@/api/types'

export interface UpdateGroup {
  key: string
  agent: AgentRef
  items: TurnUpdate[]
}

/** Consecutive updates from the same session (or, without one, the same agent) read as one block, newest first. */
export function groupUpdates(items: TurnUpdate[]): UpdateGroup[] {
  const runs: { session: string; agent: AgentRef; items: TurnUpdate[] }[] = []
  for (const u of items) {
    const session = u.activityId ?? `agent:${u.agent.id}`
    const last = runs[runs.length - 1]
    if (last && last.session === session) last.items.push(u)
    else runs.push({ session, agent: u.agent, items: [u] })
  }
  // Keyed by the session and its oldest update on the page, so a block keeps its key as newer updates land on top.
  return runs.map((r) => ({ key: `${r.session}:${r.items[r.items.length - 1].id}`, agent: r.agent, items: r.items }))
}

