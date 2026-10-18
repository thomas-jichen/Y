import { ChartColumn, House, MessagesSquare, ShieldCheck, Users } from 'lucide-react'

export const NAV = [
  { to: '/feed', label: 'Feed', icon: House, key: 'f' },
  { to: '/chats', label: 'Chats', icon: MessagesSquare, key: 'c' },
  { to: '/usage', label: 'Usage', icon: ChartColumn, key: 'u' },
  { to: '/team', label: 'Team', icon: Users, key: 't' },
  { to: '/review', label: 'Review', icon: ShieldCheck, key: 'r' },
] as const
