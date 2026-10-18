import type { AgentRef, ModelFamily } from '@/api/types'
import { personalities } from '@/mocks/cast'
import { hash32, rng } from './hash'

/**
 * Each agent's face is a long exposure of how it works: thousands of fine
 * strokes tracing a seeded noise field. The id fixes the geometry, the model
 * family picks the hues, and habits shape the field:
 *   peak hour      -> flow direction
 *   tool entropy   -> stroke count and length
 *   greenRate      -> calm vs turbulent
 *   cacheShare     -> stroke opacity
 * Unverified agents get the same geometry with no color.
 * This is the only saturated thing in the interface (design/PLAN.md).
 */

type Hue = { l: number; c: number; h: number }

export const ART_HUES = {
  vermilion: { l: 0.66, c: 0.21, h: 33 },
  amber: { l: 0.8, c: 0.16, h: 75 },
  lime: { l: 0.86, c: 0.19, h: 125 },
  jade: { l: 0.7, c: 0.14, h: 165 },
  cyan: { l: 0.76, c: 0.12, h: 215 },
  cobalt: { l: 0.55, c: 0.2, h: 262 },
  violet: { l: 0.58, c: 0.21, h: 295 },
  magenta: { l: 0.65, c: 0.24, h: 350 },
} satisfies Record<string, Hue>

type HueName = keyof typeof ART_HUES

const FAMILY: Record<ModelFamily, HueName[]> = {
  opus: ['vermilion', 'amber', 'magenta'],
  sonnet: ['jade', 'cyan', 'lime'],
  haiku: ['cyan', 'lime', 'amber'],
  codex: ['cobalt', 'violet', 'cyan'],
}

export interface ArtKnobs {
  peak: number
  entropy: number
  calm: number
  opacity: number
}

export interface ArtSpec {
  seed: number
  ground: string
  inks: { color: string; weight: number }[]
  dominant: Hue
  knobs: ArtKnobs
}

const css = (c: Hue, alpha = 1) => `oklch(${c.l.toFixed(3)} ${c.c.toFixed(3)} ${c.h.toFixed(1)}${alpha < 1 ? ` / ${alpha.toFixed(3)}` : ''})`

function entropy(shares: Record<string, number>) {
  const v = Object.values(shares)
  const h = -v.reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0)
  return h / Math.log(v.length || 1)
}

function knobsFor(agent: AgentRef): ArtKnobs {
  const p = personalities[agent.id]
  if (p) {
    return {
      peak: p.peak,
      entropy: Math.min(1, Math.max(0, (entropy(p.tools) - 0.8) / 0.2)),
      calm: Math.min(1, Math.max(0, (p.greenRate - 0.65) / 0.25)),
      opacity: Math.min(1, Math.max(0, (p.cacheShare - 0.4) / 0.35)),
    }
  }
  // agents without known habits (real API, strangers) fall back to the hash
  const r = rng(`knobs:${agent.id}`)
  return { peak: Math.floor(r() * 24), entropy: r(), calm: agent.stranger ? 0.1 : r(), opacity: r() }
}

const specs = new Map<string, ArtSpec>()

export function artSpec(agent: AgentRef): ArtSpec {
  const hit = specs.get(agent.id)
  if (hit) return hit
  // the salt is fixed forever; it was picked so the seed cast's same-family agents lead with different hues
  const seed = hash32(`art37:${agent.id}`)
  const r = rng(seed)
  const family = FAMILY[agent.model] ?? FAMILY.opus
  // rotate the family so siblings lead with different hues, then shift a little
  const start = Math.floor(r() * family.length)
  const order = family.map((_, i) => family[(start + i) % family.length])
  const count = r() > 0.4 ? 3 : 2
  const shift = (r() - 0.5) * 24
  const lift = agent.model === 'haiku' ? 0.06 : 0
  const hues: Hue[] = order.slice(0, count).map((n, i) => {
    const b = ART_HUES[n]
    if (agent.stranger) return { l: [0.86, 0.62, 0.42][i], c: 0, h: 0 }
    return { l: Math.min(0.92, b.l + lift), c: b.c, h: (b.h + shift + 360) % 360 }
  })
  const weights = count === 3 ? [0.6, 0.28, 0.12] : [0.72, 0.28]
  const darkest = agent.stranger ? { l: 0.16, c: 0, h: 0 } : { l: 0.17, c: Math.min(0.06, hues[hues.length - 1].c * 0.35), h: hues[hues.length - 1].h }
  const spec: ArtSpec = {
    seed,
    ground: css(darkest),
    inks: hues.map((h, i) => ({ color: css(h), weight: weights[i] })),
    dominant: hues[0],
    knobs: knobsFor(agent),
  }
  specs.set(agent.id, spec)
  return spec
}

/** The agent's chart color: its dominant hue, quieter. */
export function agentColor(agent: AgentRef) {
  const d = artSpec(agent).dominant
  return css({ l: d.l, c: d.c * 0.6, h: d.h })
}

// ---------- noise ----------
function makeNoise(seed: number) {
  const N = 32
  const r = rng(seed ^ 0x9e3779b9)
  const g = new Float32Array(N * N)
  for (let i = 0; i < g.length; i++) g[i] = r()
  const at = (x: number, y: number) => g[(((y % N) + N) % N) * N + (((x % N) + N) % N)]
  const smooth = (t: number) => t * t * (3 - 2 * t)
  const value = (x: number, y: number) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const tx = smooth(x - xi)
    const ty = smooth(y - yi)
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * tx
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * tx
    return a + (b - a) * ty
  }
  return (x: number, y: number) => value(x, y) * 0.68 + value(x * 2.1 + 7.3, y * 2.1 + 3.1) * 0.32
}

/** Draws the field into a canvas context of w x h device pixels. Deterministic. */
export function paintArt(ctx: CanvasRenderingContext2D, w: number, h: number, spec: ArtSpec, avatar = false) {
  const { knobs } = spec
  const r = rng(spec.seed)
  const noise = makeNoise(spec.seed)
  const unit = Math.min(w, h)
  ctx.fillStyle = spec.ground
  ctx.fillRect(0, 0, w, h)

  const base = (knobs.peak / 24) * Math.PI * 2
  const turbulence = 0.9 + (1 - knobs.calm) * 2.4
  const freq = (1.6 + r() * 1.4) / unit
  const area = (w * h) / (256 * 256)
  const strokes = Math.min(16000, Math.round((700 + knobs.entropy * 1100) * area))
  const steps = Math.round(18 + knobs.entropy * 46)
  const step = unit / 220
  // avatars are seen at 20-40px, so their strokes are heavier to keep the hue readable
  const alpha = 0.22 + knobs.opacity * 0.38 + (avatar ? 0.12 : 0)
  const weight = avatar ? 1.9 : 1
  const reach = Math.sqrt(w * h) * 0.42
  // a seeded focus where strokes gather, so small avatars still read as distinct
  const fx = (0.25 + r() * 0.5) * w
  const fy = (0.25 + r() * 0.5) * h
  const pull = (0.35 + r() * 0.3) * (avatar ? 1 : 0.4)

  ctx.lineCap = 'round'
  ctx.globalCompositeOperation = 'lighter'
  const cum = spec.inks.map((_, i) => spec.inks.slice(0, i + 1).reduce((s, k) => s + k.weight, 0))
  for (let s = 0; s < strokes; s++) {
    let x: number
    let y: number
    if (r() < pull) {
      const a = r() * Math.PI * 2
      const d = Math.pow(r(), 1.6) * reach
      x = fx + Math.cos(a) * d
      y = fy + Math.sin(a) * d
    } else {
      x = r() * w
      y = r() * h
    }
    const pick = r()
    const ink = spec.inks[cum.findIndex((c) => pick <= c + 1e-9)] ?? spec.inks[0]
    ctx.strokeStyle = ink.color
    ctx.globalAlpha = alpha * (0.4 + r() * 0.6)
    ctx.lineWidth = (0.5 + r() * 0.9) * (unit / 256) * weight
    ctx.beginPath()
    ctx.moveTo(x, y)
    for (let i = 0; i < steps; i++) {
      const a = base + (noise(x * freq, y * freq) - 0.5) * Math.PI * turbulence
      x += Math.cos(a) * step
      y += Math.sin(a) * step
      if (x < -4 || y < -4 || x > w + 4 || y > h + 4) break
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

const urls = new Map<string, string>()

/** Renders once per agent and size bucket, then serves a cached data URL. */
export function artUrl(agent: AgentRef, w: number, h = w) {
  const key = `${agent.id}:${agent.stranger ? 's' : ''}:${w}x${h}`
  const hit = urls.get(key)
  if (hit) return hit
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  paintArt(ctx, w, h, artSpec(agent), w === h && w <= 512)
  const url = canvas.toDataURL('image/webp', 0.9)
  urls.set(key, url)
  return url
}
