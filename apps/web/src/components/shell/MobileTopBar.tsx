import { Link } from '@tanstack/react-router'
import { Moon, Search, Sun } from 'lucide-react'
import { Mark } from '@/components/brand/Mark'
import { IconButton } from '@/components/primitives/Button'
import { useTheme } from '@/lib/theme'
import { ui } from '@/lib/ui'

export function MobileTopBar() {
  const [theme, toggle] = useTheme()
  return (
    <div className="glass sticky top-0 z-30 flex h-14 items-center justify-between rounded-none border-x-0 border-t-0 px-3 md:hidden">
      <Link to="/feed" className="flex items-center gap-2" aria-label="Y home">
        <Mark size={26} />
      </Link>
      <div className="flex items-center gap-1">
        <IconButton label="Jump to" onClick={() => ui.set({ palette: true })}>
          <Search size={18} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="Toggle theme" onClick={toggle}>
          {theme === 'dark' ? <Sun size={18} strokeWidth={1.75} /> : <Moon size={18} strokeWidth={1.75} />}
        </IconButton>
      </div>
    </div>
  )
}
