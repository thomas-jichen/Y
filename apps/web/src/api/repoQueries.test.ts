// Linking or unlinking a repo refreshes the repo bar and repo-scoped lists; a repo 404 is not retried.
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { updatesPage } from './adapt'
import { HttpError } from './errors'
import { noRetryOnRepoGone, teamReposChanged } from './queries'
import type { TeamDetail } from './types'

describe('teamReposChanged', () => {
  it('stores the new team detail and marks the bar status, Updates and Feed stale', () => {
    const qc = new QueryClient()
    qc.setQueryData(['repo-status', 'acme'], { repos: [] })
    qc.setQueryData(['repo-status', 'other'], { repos: [] })
    qc.setQueryData(['updates', 'acme/web'], { pages: [] })
    qc.setQueryData(['feed', 'for_you', 'acme/web'], { items: [] })
    const d = { team: { slug: 'acme' } } as unknown as TeamDetail
    teamReposChanged(qc, 'acme', d)
    expect(qc.getQueryData(['team-detail', 'acme'])).toBe(d)
    expect(qc.getQueryState(['repo-status', 'acme'])?.isInvalidated).toBe(true)
    expect(qc.getQueryState(['updates', 'acme/web'])?.isInvalidated).toBe(true)
    expect(qc.getQueryState(['feed', 'for_you', 'acme/web'])?.isInvalidated).toBe(true)
    expect(qc.getQueryState(['repo-status', 'other'])?.isInvalidated).toBe(false)
  })
})

describe('noRetryOnRepoGone', () => {
  it('a 404 is final; other errors get the usual one retry', () => {
    const nf = new HttpError(404, { error: { code: 'NOT_FOUND', message: 'gone', retryable: false } })
    expect(noRetryOnRepoGone(0, nf)).toBe(false)
    expect(noRetryOnRepoGone(0, new Error('network'))).toBe(true)
    expect(noRetryOnRepoGone(1, new Error('network'))).toBe(false)
  })
})

describe('updatesPage', () => {
  it('drops the repo key core sends: the web app keeps no repo key', () => {
    const key = 'e'.repeat(64)
    const page = updatesPage({
      items: [{ id: 'tu_1', agent: { id: 'ag_1', handle: 'vee-cc', displayName: 'Vee' }, repoKey: key, changed: 'c', building: 'b', label: 'clean', createdAt: '2026-10-20T12:00:00Z' }],
    })
    expect(page.items).toHaveLength(1)
    expect(JSON.stringify(page)).not.toContain(key)
  })
})
