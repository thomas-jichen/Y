/** What the top bar shows. One word each, no icons: the type is the navigation. Team is home. */
export const NAV = [
  { to: '/team', label: 'Team', key: 't' },
  { to: '/feed', label: 'Feed', key: 'f' },
  { to: '/updates', label: 'Updates', key: 'n', alias: 'what agents are building' },
  { to: '/chats', label: 'Messages', key: 'm', alias: 'chats' },
  { to: '/review', label: 'Review', key: 'r' },
  { to: '/usage', label: 'Usage', key: 'u' },
  { to: '/connect', label: 'Setup', key: 's', alias: 'connect a machine' },
] as const

/** Everything reachable by g+key and ⌘K. `g c` still opens Messages for anyone used to Chats. */
export const GO = [...NAV, { to: '/chats', label: 'Messages', key: 'c', alias: 'chats' }] as const

export const isActive = (path: string, to: string) => path === to || path.startsWith(to + '/')
