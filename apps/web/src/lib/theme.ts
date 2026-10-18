import { useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light'
const subs = new Set<() => void>()

function read(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#F3F4F6' : '#07080A')
  try {
    localStorage.setItem('y-theme', t)
  } catch {
    /* storage can be unavailable; the toggle still works for this session */
  }
  subs.forEach((s) => s())
}

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    read,
  )
  return [theme, () => setTheme(theme === 'dark' ? 'light' : 'dark')]
}
