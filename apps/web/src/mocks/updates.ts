import type { TurnUpdate, UpdatesPage, UpdatesSharing } from '@/api/types'
import { agents, type AgentKey } from './cast'
import { on } from './router'

const MIN = 60_000

// Synthetic per-response summaries (what core's turn_summary job writes), newest first.
// The repo is the mock's stand-in for core's salted repo key (core matches linked repos by key, server-side).
const SCRIPT: [AgentKey, string, number, string, string, string][] = [
  ['thomasOpus', 'a_01J0000000000000000000THOM', 2, 'Fixed the flaky checkout test by waiting for the cart to settle', 'Making checkout reliable before the pricing launch', 'acme/web'],
  ['laurenceOpus', 'a_01J0000000000000000000LAUR', 6, 'Added retries with backoff to the webhook sender', 'A webhook pipeline that survives partner outages', 'acme/api'],
  ['thomasOpus', 'a_01J0000000000000000000THOM', 11, 'Moved the shipping fee into the order total and updated its tests', 'Making checkout reliable before the pricing launch', 'acme/web'],
  ['mayaAstra', 'a_01J0000000000000000000MAYA', 19, 'Split the settings page into smaller components', 'A cleaner settings area with per-team preferences', 'acme/web'],
  ['laurenceOpus', 'a_01J0000000000000000000LAUR', 27, 'Wrote a failing test that reproduces the duplicate delivery bug', 'A webhook pipeline that survives partner outages', 'acme/api'],
  ['vivanOpus', 'a_01J0000000000000000000VIVN', 44, 'Renamed the usage chart props and fixed the tooltip alignment', 'A usage page that compares teammates side by side', 'acme/web'],
]

const updates: (TurnUpdate & { repo: string })[] = SCRIPT.map(([k, activityId, minsAgo, changed, building, repo], i) => ({
  id: `tu_01J00000000000000000000${String(i).padStart(3, '0')}`,
  agent: agents[k],
  activityId,
  changed,
  building,
  createdAt: new Date(Date.now() - minsAgo * MIN).toISOString(),
  repo,
}))

/** What the mock knows about each repo now: its agents working (by when they last updated) and latest update. */
export function mockRepoActivity(repo: string): { activeAgents: number; lastActivityAt?: string; agentIds: string[] } {
  const mine = updates.filter((u) => u.repo.toLowerCase() === repo.toLowerCase())
  const recent = mine.filter((u) => Date.now() - Date.parse(u.createdAt) < 15 * MIN)
  const agentIds = [...new Set(recent.map((u) => u.agent.id))]
  return { activeAgents: agentIds.length, ...(mine[0] ? { lastActivityAt: mine[0].createdAt } : {}), agentIds }
}

const sharing: UpdatesSharing = { shareWithTeam: true, teamPolicyAccepted: false }

on('GET', '/updates', ({ query }): UpdatesPage => {
  const repo = query.get('repo')?.toLowerCase()
  const items = updates.filter((u) => !repo || u.repo.toLowerCase() === repo).map(({ repo: _r, ...u }) => u)
  return { items, sharing: { ...sharing } }
})
on('GET', '/updates/sharing', (): UpdatesSharing => ({ ...sharing }))
on('POST', '/updates/sharing', ({ body }): UpdatesSharing => {
  sharing.shareWithTeam = Boolean(body?.shareWithTeam)
  return { ...sharing }
})
