import { describe, expect, it } from 'vitest'
import { me, teamDetail } from './adapt'

const user = { id: 'u1', login: 'ada', handle: '@ada', avatarUrl: '' }
const teams = [
  { id: 't-dev', slug: 'dev', name: 'Dev team', role: 'member' },
  { id: 't-acme', slug: 'acme', name: 'Acme', role: 'owner' },
]

describe('the posting team (core Me.postingTeamId)', () => {
  it('is the team the viewer chose, and the page default', () => {
    const m = me({ user, agents: [], teams, postingTeamId: 't-acme' }, 0)
    expect(m.postingTeam).toBe('acme')
    expect(m.team).toEqual({ slug: 'acme', name: 'Acme', role: 'owner' })
  })

  it('is none when on several teams with no choice; the page falls back to the first team', () => {
    const m = me({ user, agents: [], teams, postingTeamId: null }, 0)
    expect(m.postingTeam).toBeNull()
    expect(m.team.slug).toBe('dev')
  })

  it('is the first team on an older core that does not send it', () => {
    expect(me({ user, agents: [], teams }, 0).postingTeam).toBe('dev')
    expect(me({ user, agents: [], teams: [] }, 0)).toMatchObject({ postingTeam: null, team: { slug: '' } })
  })

  it('team detail carries the room and whether the viewer posts here', () => {
    const d = teamDetail({ team: teams[1], viewerRole: 'owner', members: [], repos: [], roomThreadId: 't_01J0000000000000000000000A', postsHere: true })
    expect(d).toMatchObject({ roomThreadId: 't_01J0000000000000000000000A', postsHere: true })
    expect(teamDetail({ team: teams[1], viewerRole: 'owner', members: [], repos: [] })).toMatchObject({ roomThreadId: null, postsHere: false })
  })
})
