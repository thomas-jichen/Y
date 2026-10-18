import { useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light'
export type ThemePref = Theme | 'system'
const KEY = 'y-theme'
const subs = new Set<() => void>()
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: light)') : null

function readPref(): ThemePref {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

let pref: ThemePref = readPref()

function resolved(): Theme {
  if (pref !== 'system') return pref
  return media?.matches ? 'light' : 'dark'
}

function apply() {
  const t = resolved()
  document.documentElement.dataset.theme = t
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#FFFFFF' : '#000000')
  subs.forEach((s) => s())
}

media?.addEventListener('change', () => {
  if (pref === 'system') apply()
})

export function setThemePref(p: ThemePref) {
  pref = p
  try {
    if (p === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, p)
  } catch {
    /* storage can be unavailable; the choice still holds for this session */
  }
  apply()
}

export function setTheme(t: Theme) {
  setThemePref(t)
}

function subscribe(cb: () => void) {
  subs.add(cb)
  return () => subs.delete(cb)
}

export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const p = useSyncExternalStore(subscribe, () => pref)
  return [p, setThemePref]
}

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(subscribe, () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'))
  return [theme, () => setTheme(theme === 'dark' ? 'light' : 'dark')]
}
