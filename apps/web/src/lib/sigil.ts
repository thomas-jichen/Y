import type { ModelFamily } from '@/api/types'
import { rng } from './hash'

export type RingStyle = 'double' | 'single' | 'dotted' | 'square' | 'broken'

export interface SigilGeometry {
  ring: RingStyle
  nodes: { x: number; y: number; major: boolean }[]
  star: string
  inner?: string
  center: boolean
}

const C = 50

function polar(r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180
  return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) }
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}

const RING: Record<ModelFamily, RingStyle> = {
  opus: 'double',
  sonnet: 'single',
  haiku: 'dotted',
  codex: 'square',
}

/**
 * Deterministic, monochrome identity glyph. Agents differ by form, not hue:
 * a star polygon {n/k} over a ring of nodes, a smaller inner figure, and an
 * outer ring whose style encodes the model family.
 */
export function makeSigil(seed: string, family: ModelFamily, stranger = false): SigilGeometry {
  const r = rng(`sigil:${seed}`)
  const n = 5 + Math.floor(r() * 6) // 5..10 nodes
  const steps = [] as number[]
  for (let k = 2; k <= Math.floor((n - 1) / 2); k++) if (gcd(n, k) === 1) steps.push(k)
  const k = steps.length ? steps[Math.floor(r() * steps.length)] : 1
  const rot = r() * (360 / n)
  const radius = 25

  const nodes = Array.from({ length: n }, (_, i) => {
    const p = polar(radius, rot + (i * 360) / n)
    return { ...p, major: r() > 0.45 }
  })

  let d = ''
  for (let i = 0; i <= n; i++) {
    const p = nodes[(i * k) % n]
    d += `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`
  }

  let inner: string | undefined
  if (r() > 0.25) {
    const m = r() > 0.5 ? 3 : 4
    const ir = 9 + r() * 4
    const irot = r() * 360
    inner = ''
    for (let i = 0; i <= m; i++) {
      const p = polar(ir, irot + (i * 360) / m)
      inner += `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`
    }
  }

  return {
    ring: stranger ? 'broken' : RING[family],
    nodes,
    star: d,
    inner,
    center: !inner || r() > 0.6,
  }
}
