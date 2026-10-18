const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat('en-US')

export function fmtTokens(n: number) {
  if (n < 1000) return String(n)
  return compact.format(n).toLowerCase()
}

export function fmtCompact(n: number) {
  return n < 1000 ? whole.format(Math.round(n)) : compact.format(n)
}

export function fmtNum(n: number) {
  return whole.format(n)
}

export function fmtUsd(n: number, digits = 2) {
  if (n >= 1000) return `$${compact.format(n)}`
  return `$${n.toFixed(digits)}`
}

export function fmtPct(n: number, digits = 0) {
  return `${(n * 100).toFixed(digits)}%`
}

export function fmtSignedPct(n: number, digits = 0) {
  const v = (n * 100).toFixed(digits)
  return n > 0 ? `+${v}%` : n < 0 ? `−${v.replace('-', '')}%` : `${v}%`
}

export function fmtDuration(ms: number) {
  const m = Math.round(ms / 60000)
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h}h ${String(r).padStart(2, '0')}m` : `${h}h`
}

export function fmtHours(ms: number) {
  const h = ms / 3600000
  return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`
}

export function fmtAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function fmtClock(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function fmtCountdown(iso: string, now = Date.now()) {
  const ms = new Date(iso).getTime() - now
  if (ms <= 0) return 'now'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${fmtNum(n)} ${n === 1 ? one : many}`
}
