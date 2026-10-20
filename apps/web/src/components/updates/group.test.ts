// Updates tab: core's UpdatesPage adapter and the per-session grouping.
import { describe, expect, it } from 'vitest'
import * as A from '@/api/adapt'
import { groupUpdates } from './group'

const owner = { id: 'u1', login: 'ann', handle: '@ann', avatarUrl: '' }
const agentA = { id: 'ag1', handle: '@ann-opus', harness: 'claude_code', owner }
const agentB = { id: 'ag2', handle: '@bo-astra', harness: 'codex', owner: { ...owner, id: 'u2', login: 'bo', handle: '@bo' } }
const at = (m: number) => new Date(Date.UTC(2026, 9, 19, 12, m)).toISOString()

const core = {
  items: [
    { id: 'tu_3', agent: agentA, activityId: 'a_1', changed: 'Fixed the total', building: 'Checkout', createdAt: at(3) },
    { id: 'tu_2', agent: agentA, activityId: 'a_1', changed: 'Added a test', building: 'Checkout', createdAt: at(2) },
    { id: 'tu_1', agent: agentB, activityId: 'a_2', changed: 'Split the page', building: 'Settings', createdAt: at(1) },
    { id: 'tu_0', agent: agentA, changed: 'Read the docs', building: 'Checkout', createdAt: at(0) },
  ],
  nextCursor: 'abc',
}

describe('updates', () => {
  it('adapts core agent refs (bare handles, web harness names) and keeps the cursor', () => {
    const page = A.updatesPage(core)
    expect(page.nextCursor).toBe('abc')
    expect(page.items[0].agent.handle).toBe('ann-opus')
    expect(page.items[2].agent.harness).toBe('astra')
    expect(page.items[3].activityId).toBeUndefined()
    expect(A.updatesPage({}).items).toEqual([])
  })

  it('keeps a screen label (not clean) and the sharing setting from the first page', () => {
    const page = A.updatesPage({
      items: [
        { ...core.items[0], label: 'warn' },
        { ...core.items[1], label: 'clean' },
      ],
      sharing: { shareWithTeam: true, teamPolicyAccepted: false },
    })
    expect(page.items[0].label).toBe('warn')
    expect(page.items[1].label).toBeUndefined()
    expect(page.sharing).toEqual({ shareWithTeam: true, teamPolicyAccepted: false })
    expect(A.updatesPage(core).sharing).toBeUndefined()
  })

  it('groups consecutive updates of one session, newest first, with stable keys', () => {
    const items = A.updatesPage(core).items
    const groups = groupUpdates(items)
    expect(groups.map((g) => g.items.map((u) => u.id))).toEqual([['tu_3', 'tu_2'], ['tu_1'], ['tu_0']])
    const newer = { ...items[0], id: 'tu_4', createdAt: at(4) }
    expect(groupUpdates([newer, ...items])[0].key).toBe(groups[0].key)
  })
})
