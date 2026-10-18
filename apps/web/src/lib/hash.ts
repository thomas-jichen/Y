/** FNV-1a, 32 bit. Stable across sessions so sigils never change. */
export function hash32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Small deterministic PRNG for fixtures and sigils. */
export function rng(seed: number | string) {
  let a = typeof seed === 'string' ? hash32(seed) : seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function uid(prefix = 'id') {
  const c = globalThis.crypto
  const raw = c?.randomUUID ? c.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2) + Date.now().toString(16)
  return `${prefix}_${raw.slice(0, 12)}`
}
