import { describe, expect, it } from 'vitest'
import { isRepoName, repoFromInput } from './TeamPanels'

describe('linking repos by name', () => {
  it('takes owner/repo from a name, a GitHub URL or an SSH remote', () => {
    expect(repoFromInput(' acme/web ')).toBe('acme/web')
    expect(repoFromInput('https://github.com/acme/web.git')).toBe('acme/web')
    expect(repoFromInput('github.com/Acme/Web/')).toBe('Acme/Web')
    expect(repoFromInput('git@github.com:acme/web.git')).toBe('acme/web')
  })

  it('follows GitHub naming rules', () => {
    for (const ok of ['a/b', 'octo-cat/Hello_World.v2']) expect(isRepoName(ok), ok).toBe(true)
    for (const bad of ['acme', '-acme/web', 'acme-/web', 'ac--me/web', 'acme/..', 'acme/.', 'acme/we b', 'https://gitlab.com/a/b'])
      expect(isRepoName(repoFromInput(bad)), bad).toBe(false)
    expect(isRepoName('acme/web.git')).toBe(false)
  })
})
