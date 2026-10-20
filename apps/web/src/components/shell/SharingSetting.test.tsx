// The update-sharing switch moved from the Updates page into the account menu (MeMenu): same behaviour.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SHARING_LABEL, SharingSetting } from './SharingSetting'

const render = (p: Partial<Parameters<typeof SharingSetting>[0]>) => renderToStaticMarkup(<SharingSetting sharing={undefined} onChange={() => undefined} {...p} />)
const switchOf = (html: string) => /<button[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? ''

describe('SharingSetting', () => {
  it('is on by default and explains what teammates see', () => {
    const html = render({ sharing: { shareWithTeam: true, teamPolicyAccepted: false } })
    expect(html).toContain(SHARING_LABEL)
    expect(switchOf(html)).toContain('aria-checked="true"')
    expect(switchOf(html)).not.toMatch(/ disabled=""/)
    expect(html).toContain('Teammates see what your agents changed and are building.')
  })

  it('off keeps updates to the viewer', () => {
    const html = render({ sharing: { shareWithTeam: false, teamPolicyAccepted: false } })
    expect(switchOf(html)).toContain('aria-checked="false"')
    expect(html).toContain('Only you see your agents’ updates.')
  })

  it('is locked on with a note once the team policy is accepted', () => {
    const html = render({ sharing: { shareWithTeam: false, teamPolicyAccepted: true } })
    expect(switchOf(html)).toContain('aria-checked="true"')
    expect(switchOf(html)).toMatch(/ disabled=""/)
    expect(html).toContain('You accepted your team’s policy')
  })

  it('shows the value being saved, disabled, and an alert when saving failed', () => {
    const saving = render({ sharing: { shareWithTeam: true, teamPolicyAccepted: false }, pending: false })
    expect(switchOf(saving)).toContain('aria-checked="false"')
    expect(switchOf(saving)).toMatch(/ disabled=""/)
    const failed = render({ sharing: { shareWithTeam: true, teamPolicyAccepted: false }, saveFailed: true })
    expect(failed).toContain('role="alert"')
  })

  it('while loading or after a failed load: the default, disabled', () => {
    expect(switchOf(render({}))).toMatch(/ disabled=""/)
    expect(render({ loadFailed: true })).toContain('Couldn’t load this setting')
  })

  it('lives in the account menu below Theme, and no longer on the Updates page', () => {
    const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
    const menu = src('./MeMenu.tsx')
    expect(menu.indexOf('<Sharing />')).toBeGreaterThan(menu.indexOf('aria-label="Theme"'))
    const updates = src('../../routes/updates.tsx')
    expect(updates).not.toContain('useUpdatesSharing')
    expect(updates).not.toContain('<Switch')
  })
})
