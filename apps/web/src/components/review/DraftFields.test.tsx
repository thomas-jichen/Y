// The draft review's switches send only what core honours, and nothing else promises an effect (#37).
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { reviewDetail } from '@/api/adapt'
import type { DraftReview } from '@/api/types'
import { DraftFields, draftMode, initialFields, NEUTRAL_ACTIVITY_TITLE, NEUTRAL_HIGHLIGHT_TITLE, publishEdits, toggleKeys } from './DraftFields'

const agent = { id: 'a_1', handle: 'mine', owner: { id: 'u_1', handle: 'me' }, harness: 'claude_code' }
const hl = { id: 'h_9', kind: 'gotcha', title: 'PGlite needs the vector extension loaded first', summary: 'Load it before migrating.', body: {}, tags: [] }
const coreDraft = (extra: Record<string, unknown> = {}) => ({
  item: { id: 'rv_1', kind: 'draft', state: 'pending', summary: 'Draft', createdAt: '2026-10-18T00:00:00Z', refId: 'h_9' },
  activity: { id: 'a_7', agent, title: 'Fixed the migration runner', summary: 'Two tests were flaky.', repoLabel: 'acme/api', highlights: [hl], setup: { id: 's', hash: 'x', model: 'claude-opus-5-5', components: [{ kind: 'skill', name: 'db-migrate', contentShared: true }] } },
  redactedDigest: '',
  receipt: { bytes: 1, sha256: '0'.repeat(64), hitsByRule: {}, droppedDigest: false, deletesAt: '2026-10-19T00:00:00Z' },
  fieldToggles: {},
  componentShareToggles: {},
  ...extra,
})
const adapt = (extra?: Record<string, unknown>) => {
  const d = reviewDetail(coreDraft(extra))
  if (d.type !== 'draft') throw new Error('expected a draft')
  return d
}

describe('draft field toggles (#37)', () => {
  it('a highlight draft offers highlight, title and summary; an activity draft only title and summary', () => {
    const h = adapt({ highlightId: 'h_9' })
    expect(draftMode(h)).toBe('highlight')
    expect(toggleKeys(h)).toEqual(['highlight', 'title', 'summary'])
    const a = adapt()
    expect(draftMode(a)).toBe('activity')
    expect(toggleKeys(a)).toEqual(['title', 'summary'])
  })

  it('an all-on publish sends no edits (the default request is unchanged)', () => {
    const d = adapt({ highlightId: 'h_9' })
    expect(initialFields(d)).toEqual({ highlight: true, title: true, summary: true })
    expect(publishEdits(initialFields(d))).toBeUndefined()
  })

  it('a switched-off field is sent as edits.fieldToggles, with honoured keys only', () => {
    const a = adapt()
    expect(publishEdits({ ...initialFields(a), summary: false })).toEqual({ fieldToggles: { title: true, summary: false } })
    const h = adapt({ highlightId: 'h_9' })
    const sent = publishEdits({ ...initialFields(h), highlight: false })
    expect(sent).toEqual({ fieldToggles: { highlight: false, title: true, summary: true } })
    expect(Object.keys(sent!.fieldToggles)).not.toContain('repoLabel')
  })

  it('component sharing and the repo name show read-only, never as working switches', () => {
    const a = adapt()
    const html = renderToStaticMarkup(<DraftFields d={a} fields={initialFields(a)} onChange={() => undefined} />)
    expect(html).toContain('db-migrate')
    expect(html).toContain('Publishing this draft does not change it')
    expect(html).toContain('always posts with the card')
    // The only enabled switches are title and summary.
    const enabled = [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((m) => m[0]).filter((b) => !/\sdisabled=""/.test(b))
    expect(enabled.map((b) => /aria-label="([^"]+)"/.exec(b)?.[1])).toEqual(['Title', 'Summary'])
    expect(html).not.toContain('aria-label="Highlight"')
  })

  it('the preview shows what core will post when a title is off', () => {
    const a = adapt()
    const offA = renderToStaticMarkup(<DraftFields d={a} fields={{ title: false, summary: false }} onChange={() => undefined} />)
    expect(offA).toContain(NEUTRAL_ACTIVITY_TITLE)
    expect(offA).not.toContain('Two tests were flaky.')
    const h = adapt({ highlightId: 'h_9' })
    const offH = renderToStaticMarkup(<DraftFields d={h} fields={{ highlight: true, title: false, summary: true }} onChange={() => undefined} />)
    expect(offH).toContain(NEUTRAL_HIGHLIGHT_TITLE)
    expect(offH).toContain('Load it before migrating.')
    const kept = renderToStaticMarkup(<DraftFields d={h} fields={{ highlight: false, title: true, summary: true }} onChange={() => undefined} />)
    expect(kept).toContain('Nothing from this highlight will post')
    expect(kept).not.toContain('PGlite needs')
  })

  it('mock-mode drafts (no toggleable list) keep the highlight switch', () => {
    const d = { ...adapt({ highlightId: 'h_9' }), toggleable: undefined } as DraftReview
    expect(toggleKeys(d)).toEqual(['highlight', 'title', 'summary'])
  })
})
