import { useSyncExternalStore } from 'react'

// The repo the viewer scoped the app to with the bar under the top nav: one GitHub repo linked to
// their posting team (owner/repo), or null for all repos. Remembered per browser; routes that
// filter by it (Updates, Feed) also carry it as ?repo=owner/repo so a link keeps the scope.

const KEY = 'y.repo'
/** GitHub naming, as packages/schema GithubRepoName: owner/repo, no `.git` suffix, not `.` or `..`. */
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/

/** Routes that read ?repo= (and filter by it). Elsewhere the choice is only remembered. */
export const REPO_ROUTES = ['/updates', '/feed'] as const

/** A repo name from untrusted input (URL, storage), or undefined. */
export function parseRepo(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 140 || !REPO_RE.test(v)) return undefined
  if (/\/\.{1,2}$/.test(v) || /\.git$/i.test(v)) return undefined
  return v
}

/** The linked repo matching `want` (GitHub compares names case-insensitively), else null. */
export function matchRepo(want: string | null | undefined, linked: readonly string[]): string | null {
  if (!want) return null
  const w = want.toLowerCase()
  return linked.find((r) => r.toLowerCase() === w) ?? null
}

function read(): string | null {
  try {
    return parseRepo(localStorage.getItem(KEY)) ?? null
  } catch {
    return null
  }
}

let stored: string | null = typeof window === 'undefined' ? null : read()
const subs = new Set<() => void>()

/** Remember the choice in this browser (null = all repos). Storage failures only lose the memory. */
export function setStoredRepo(repo: string | null) {
  stored = repo ? (parseRepo(repo) ?? null) : null
  try {
    if (stored) localStorage.setItem(KEY, stored)
    else localStorage.removeItem(KEY)
  } catch {
    /* storage unavailable: the choice lasts for this tab only */
  }
  subs.forEach((s) => s())
}

export function useStoredRepo(): string | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => stored,
    () => null,
  )
}
