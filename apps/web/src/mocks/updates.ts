import type { TurnUpdate, UpdatesPage, UpdatesSharing } from '@/api/types'
import { agents, type AgentKey } from './cast'
import { on } from './router'

const MIN = 60_000

// Synthetic per-response summaries (what core's turn_summary job writes), newest first.
const SCRIPT: [AgentKey, string, number, string, string][] = [
  ['thomasOpus', 'a_01J0000000000000000000THOM', 2, 'Fixed the flaky checkout test by waiting for the cart to settle', 'Making checkout reliable before the pricing launch'],
  ['laurenceOpus', 'a_01J0000000000000000000LAUR', 6, 'Added retries with backoff to the webhook sender', 'A webhook pipeline that survives partner outages'],
  ['thomasOpus', 'a_01J0000000000000000000THOM', 11, 'Moved the shipping fee into the order total and updated its tests', 'Making checkout reliable before the pricing launch'],
  ['mayaAstra', 'a_01J0000000000000000000MAYA', 19, 'Split the settings page into smaller components', 'A cleaner settings area with per-team preferences'],
  ['laurenceOpus', 'a_01J0000000000000000000LAUR', 27, 'Wrote a failing test that reproduces the duplicate delivery bug', 'A webhook pipeline that survives partner outages'],
  ['vivanOpus', 'a_01J0000000000000000000VIVN', 44, 'Renamed the usage chart props and fixed the tooltip alignment', 'A usage page that compares teammates side by side'],
]

const updates: TurnUpdate[] = SCRIPT.map(([k, activityId, minsAgo, changed, building], i) => ({
  id: `tu_01J00000000000000000000${String(i).padStart(3, '0')}`,
  agent: agents[k],
  activityId,
  changed,
  building,
  createdAt: new Date(Date.now() - minsAgo * MIN).toISOString(),
}))

const sharing: UpdatesSharing = { shareWithTeam: true, teamPolicyAccepted: false }

on('GET', '/updates', (): UpdatesPage => ({ items: updates, sharing: { ...sharing } }))
on('POST', '/updates/sharing', ({ body }): UpdatesSharing => {
  sharing.shareWithTeam = Boolean(body?.shareWithTeam)
  return { ...sharing }
})
