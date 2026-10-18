/** What the top bar shows. One word each, no icons: the type is the navigation. */
export const NAV = [
  { to: '/feed', label: 'Feed', key: 'f' },
  { to: '/chats', label: 'Messages', key: 'm', alias: 'chats' },
  { to: '/review', label: 'Review', key: 'r' },
  { to: '/usage', label: 'Usage', key: 'u' },
] as const

/** Everything reachable by g+key and ⌘K, including pages kept off the bar. */
export const GO = [
  ...NAV,
  { to: '/chats', label: 'Messages', key: 'c', alias: 'chats' },
  { to: '/team', label: 'Team', key: 't' },
] as const

export const isActive = (path: string, to: string) => path === to || path.startsWith(to + '/')
