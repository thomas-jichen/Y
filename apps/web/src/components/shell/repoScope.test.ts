// The repo scope follows the viewer across pages: the remembered choice and ?repo= stay in step.
import { describe, expect, it } from 'vitest'
import { HttpError } from '@/api/errors'
import type { TeamReposStatus } from '@/api/types'
import { isRepoGone, repoSyncPlan, withoutRepo } from './repoScope'

const linked = ['acme/api', 'Acme/Web']

describe('repoSyncPlan', () => {
  it('a linked ?repo= on Updates or Feed becomes the remembered choice (the URL wins)', () => {
    // A shared link /updates?repo=acme/web opened while All is remembered: Team and Feed keep it after.
    expect(repoSyncPlan({ route: true, fromUrl: 'acme/web', stored: null, linked })).toEqual({ store: 'Acme/Web', url: 'Acme/Web' })
    expect(repoSyncPlan({ route: true, fromUrl: 'Acme/Web', stored: 'acme/api', linked })).toEqual({ store: 'Acme/Web' })
  })

  it('a repo route opened without ?repo= gets the remembered one written in, so a copied link keeps the scope', () => {
    expect(repoSyncPlan({ route: true, fromUrl: undefined, stored: 'acme/api', linked })).toEqual({ url: 'acme/api' })
  })

  it('nothing to do when both agree, or on other routes with a linked choice', () => {
    expect(repoSyncPlan({ route: true, fromUrl: 'acme/api', stored: 'acme/api', linked })).toEqual({})
    expect(repoSyncPlan({ route: true, fromUrl: undefined, stored: null, linked })).toEqual({})
    expect(repoSyncPlan({ route: false, fromUrl: undefined, stored: 'acme/api', linked })).toEqual({})
    // Off a repo route ?repo= means nothing and is left alone.
    expect(repoSyncPlan({ route: false, fromUrl: 'acme/web', stored: null, linked })).toEqual({})
  })

  it('a repo the team does not link (any more) is dropped from both: all repos', () => {
    expect(repoSyncPlan({ route: true, fromUrl: 'acme/gone', stored: 'acme/gone', linked })).toEqual({ store: null, url: null })
    expect(repoSyncPlan({ route: false, fromUrl: undefined, stored: 'acme/gone', linked })).toEqual({ store: null })
    expect(repoSyncPlan({ route: true, fromUrl: undefined, stored: 'acme/gone', linked: [] })).toEqual({ store: null })
  })
})

describe('isRepoGone', () => {
  const nf = new HttpError(404, { error: { code: 'NOT_FOUND', message: 'No such repo', retryable: false } })
  it('a 404 on a repo-scoped request means the repo was unlinked', () => {
    expect(isRepoGone('acme/web', nf)).toBe(true)
  })
  it('anything else is a real error (or no repo scope at all)', () => {
    expect(isRepoGone(null, nf)).toBe(false)
    expect(isRepoGone('acme/web', new HttpError(500, { error: { code: 'INTERNAL', message: 'x', retryable: true } }))).toBe(false)
    expect(isRepoGone('acme/web', new Error('network'))).toBe(false)
    expect(isRepoGone('acme/web', null)).toBe(false)
  })
})

describe('withoutRepo', () => {
  it('drops the unlinked repo from the cached status (any casing), so the sync falls back to all repos', () => {
    const s: TeamReposStatus = {
      team: { id: 'tm_1', slug: 'acme', name: 'Acme' },
      viewerRole: 'member',
      repos: [
        { repo: 'acme/api', activeAgents: 0 },
        { repo: 'Acme/Web', activeAgents: 1 },
      ],
      all: { activeAgents: 1 },
    }
    const after = withoutRepo(s, 'acme/web')
    expect(after.repos.map((r) => r.repo)).toEqual(['acme/api'])
    expect(repoSyncPlan({ route: true, fromUrl: 'Acme/Web', stored: 'Acme/Web', linked: after.repos.map((r) => r.repo) })).toEqual({ store: null, url: null })
  })
})
