import type { DraftReview, Highlight } from '@/api/types'
import { Switch } from '@/components/primitives/Switch'
import { SafeText } from '@/lib/safeText'

/**
 * What a draft's "What will be posted" switches really do (#37). Core honours edits.fieldToggles
 * for title and summary on every draft, and for highlight only on a highlight draft (h_), where
 * title and summary are the highlight's. Nothing else is honoured, so nothing else gets a working
 * switch: those fields show as they will post, and component sharing shows read-only.
 */

/** Core's neutral titles (apps/core pipeline.ts) for a title the owner turned off. */
export const NEUTRAL_HIGHLIGHT_TITLE = 'Highlight from a captured session'
export const NEUTRAL_ACTIVITY_TITLE = 'Shared a coding session'

const DEFAULT_TOGGLEABLE = ['title', 'summary', 'highlight']

/** A highlight draft publishes (or archives) the drafted highlight; an activity draft publishes the session card. */
export const draftMode = (d: Pick<DraftReview, 'toggleable'>): 'highlight' | 'activity' =>
  (d.toggleable ?? DEFAULT_TOGGLEABLE).includes('highlight') ? 'highlight' : 'activity'

/** The switches the human can use, in display order. */
export function toggleKeys(d: Pick<DraftReview, 'toggleable'>): string[] {
  const can = d.toggleable ?? DEFAULT_TOGGLEABLE
  const order = draftMode(d) === 'highlight' ? ['highlight', 'title', 'summary'] : ['title', 'summary']
  return order.filter((k) => can.includes(k))
}

/** Initial switch state: every honoured field, on unless core sent it off. */
export function initialFields(d: Pick<DraftReview, 'toggleable' | 'fieldToggles'>): Record<string, boolean> {
  return Object.fromEntries(toggleKeys(d).map((k) => [k, d.fieldToggles[k] !== false]))
}

/**
 * The edits a publish sends: the honoured toggles, only when one is off. With every switch on
 * nothing is sent, so a default publish is exactly the request it always was.
 */
export function publishEdits(fields: Record<string, boolean>): { fieldToggles: Record<string, boolean> } | undefined {
  return Object.values(fields).some((v) => v === false) ? { fieldToggles: { ...fields } } : undefined
}

const KIND: Record<Highlight['kind'], string> = { fix: 'Fix', gotcha: 'Gotcha', recipe: 'Recipe', workflow: 'Workflow', tool_tip: 'Tool tip' }
const LABEL: Record<string, string> = { title: 'Title', summary: 'Summary', highlight: 'Highlight' }

export function DraftFields({ d, fields, onChange }: { d: DraftReview; fields: Record<string, boolean>; onChange: (next: Record<string, boolean>) => void }) {
  const mode = draftMode(d)
  const h = d.activity.highlights[0]
  const keys = toggleKeys(d)
  const on = (k: string) => fields[k] !== false
  const highlightOff = mode === 'highlight' && !on('highlight')
  return (
    <>
      <div className="border border-rule p-5 text-body">
        {mode === 'highlight' ? (
          highlightOff ? (
            <div className="text-ui text-text-2">Nothing from this highlight will post. It stays private to you.</div>
          ) : (
            h && (
              <div className="grid grid-cols-[72px_1fr] gap-x-4 text-ui">
                <span className="font-semibold">{KIND[h.kind] ?? 'Highlight'}</span>
                <div>
                  {on('title') ? <SafeText text={h.title} /> : <span className="text-text-2">{NEUTRAL_HIGHLIGHT_TITLE}</span>}
                  {on('summary') && h.summary && (
                    <div className="mt-1 text-text-2">
                      <SafeText text={h.summary} />
                    </div>
                  )}
                </div>
              </div>
            )
          )
        ) : (
          <>
            <div className="font-medium">{on('title') ? d.activity.title : <span className="text-text-2">{NEUTRAL_ACTIVITY_TITLE}</span>}</div>
            {on('summary') && d.activity.summary && (
              <div className="mt-1 text-text-2">
                <SafeText text={d.activity.summary} />
              </div>
            )}
            {d.activity.repoLabel && <div className="mt-3 text-caption text-text-2">in {d.activity.repoLabel}</div>}
          </>
        )}
      </div>
      <div className="mt-6 divide-y divide-rule border-y border-rule">
        {keys.map((k) => (
          <label key={k} className="flex items-center justify-between py-3 text-ui">
            {LABEL[k] ?? k}
            <Switch checked={on(k)} disabled={k !== 'highlight' && highlightOff} onCheckedChange={(x) => onChange({ ...fields, [k]: x })} label={LABEL[k] ?? k} />
          </label>
        ))}
        {mode === 'activity' && d.activity.repoLabel && (
          <label className="flex items-center justify-between py-3 text-ui">
            <span>
              Repo name <span className="text-text-2">· always posts with the card</span>
            </span>
            <Switch checked disabled onCheckedChange={() => undefined} label="Repo name (always posts)" />
          </label>
        )}
      </div>
      {Object.keys(d.componentShareToggles).length > 0 && (
        <>
          <h3 className="mb-1 mt-8 text-caption text-text-2">Component content</h3>
          <p className="mb-1 text-caption text-text-2">Each component keeps its own sharing setting. Publishing this draft does not change it.</p>
          <div className="divide-y divide-rule border-y border-rule">
            {Object.entries(d.componentShareToggles).map(([k, v]) => (
              <label key={k} className="flex items-center justify-between py-3">
                <span className="font-mono text-ui">
                  {k} <span className="font-sans text-caption text-text-2">· {v ? 'shared' : 'not shared'}</span>
                </span>
                <Switch checked={v} disabled onCheckedChange={() => undefined} label={`${k} content ${v ? 'shared' : 'not shared'}`} />
              </label>
            ))}
          </div>
        </>
      )}
    </>
  )
}
