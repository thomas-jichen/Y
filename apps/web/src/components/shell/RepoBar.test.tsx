// The repo bar under the top nav: when it shows, what it says, and that it carries repo names only.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { teamReposStatus } from '@/api/adapt'
import type { Me, TeamReposStatus } from '@/api/types'
import { RepoBarView, repoBarModel, repoStatusLine, type RepoBarModel } from './RepoBar'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000

const me = (postingTeam: string | null): Me => ({
  user: { id: 'u_1', handle: '@vee', name: 'Vee' } as Me['user'],
  agents: [],
  team: { slug: postingTeam ?? '', name: postingTeam ?? 'No team' },
  postingTeam,
  reviewCount: 0,
  remoteInstructionsOn: false,
})

const status = (o: Partial<TeamReposStatus> = {}): TeamReposStatus => ({
  team: { id: 'tm_1', slug: 'acme', name: 'Acme' },
  viewerRole: 'member',
  repos: [
    { repo: 'acme/api', activeAgents: 0, lastActivityAt: ago(3 * 60 * MIN) },
    { repo: 'Acme/Web', activeAgents: 2, lastActivityAt: ago(5 * MIN) },
  ],
  all: { activeAgents: 2, lastActivityAt: ago(5 * MIN) },
  ...o,
})

const html = (model: RepoBarModel) => renderToStaticMarkup(<RepoBarView model={model} onSelect={() => undefined} onLinkRepo={() => undefined} now={NOW} />)

describe('repoBarModel', () => {
  it('shows nothing without a posting team, before the status loads, or for another team', () => {
    expect(repoBarModel(undefined, status(), null)).toBeNull()
    expect(repoBarModel(me(null), status(), null)).toBeNull()
    expect(repoBarModel(me('acme'), undefined, null)).toBeNull()
    expect(repoBarModel(me('other'), status(), null)).toBeNull()
  })

  it('with no linked repos: a "Link a repo" link for owners and admins, nothing for members', () => {
    expect(repoBarModel(me('acme'), status({ repos: [] }), null)).toBeNull()
    expect(repoBarModel(me('acme'), status({ repos: [], viewerRole: 'admin' }), null)).toEqual({ kind: 'link', team: 'acme' })
    expect(repoBarModel(me('acme'), status({ repos: [], viewerRole: 'owner' }), null)).toEqual({ kind: 'link', team: 'acme' })
  })

  it('selects the wanted repo when the team links it (any casing), else all repos', () => {
    expect(repoBarModel(me('acme'), status(), 'acme/web')).toMatchObject({ kind: 'bar', selected: 'Acme/Web' })
    expect(repoBarModel(me('acme'), status(), 'acme/gone')).toMatchObject({ kind: 'bar', selected: null })
    expect(repoBarModel(me('acme'), status(), null)).toMatchObject({ kind: 'bar', selected: null })
  })
})

describe('repoStatusLine', () => {
  it('one line: agents working, then when it last updated', () => {
    expect(repoStatusLine({ activeAgents: 2, lastActivityAt: ago(5 * MIN) }, NOW)).toBe('2 agents working · updated 5m ago')
    expect(repoStatusLine({ activeAgents: 1, lastActivityAt: ago(10_000) }, NOW)).toBe('1 agent working · updated just now')
    expect(repoStatusLine({ activeAgents: 0, lastActivityAt: ago(3 * 60 * MIN) }, NOW)).toBe('no agents working · updated 3h ago')
    expect(repoStatusLine({ activeAgents: 0 }, NOW)).toBe('no agents working · no updates yet')
    expect(repoStatusLine({ activeAgents: 0, lastActivityAt: ago(30 * 24 * 60 * MIN) }, NOW)).toMatch(/^no agents working · updated [A-Z][a-z]{2} \d{1,2}$/)
  })
})

describe('RepoBarView', () => {
  it('a selector with All repos and every linked repo, and the status of the selection', () => {
    const all = html(repoBarModel(me('acme'), status(), null)!)
    expect(all).toContain('aria-label="Repo"')
    expect(all).toContain('<option value="" selected="">All repos</option>')
    expect(all).toContain('<option value="acme/api">acme/api</option>')
    expect(all).toContain('<option value="Acme/Web">Acme/Web</option>')
    expect(all).toContain('2 agents working · updated 5m ago')

    const api = html(repoBarModel(me('acme'), status(), 'ACME/API')!)
    expect(api).toContain('<option value="acme/api" selected="">acme/api</option>')
    expect(api).toContain('no agents working · updated 3h ago')
    // Sits under the fixed nav (top-6 + h-12), in the same 860 px column, on glass.
    expect(api).toMatch(/fixed inset-x-0 top-\[80px\]/)
    expect(api).toContain('max-w-[860px]')
    expect(api).toContain('glass')
  })

  it('the link variant points at the team page', () => {
    const link = html({ kind: 'link', team: 'acme' })
    expect(link).toContain('href="/team?team=acme"')
    expect(link).toContain('Link a repo')
    expect(link).not.toContain('<select')
  })

  it('carries repo names only: whatever else core sent is dropped by the adapter', () => {
    const key = 'f'.repeat(64)
    const s = teamReposStatus({
      team: { id: 'tm_1', slug: 'acme', name: 'Acme' },
      viewerRole: 'member',
      repos: [{ repo: 'acme/web', activeAgents: 1, repoKey: key, salt: key }],
      all: { activeAgents: 1, repoKey: key },
    })
    expect(JSON.stringify(s)).not.toContain(key)
    expect(html(repoBarModel(me('acme'), s, null)!)).not.toMatch(/[0-9a-f]{64}/)
  })
})
