import { MOCKS } from '@/lib/env'
import { uid } from '@/lib/hash'
import { HttpError } from './errors'

export { HttpError }

// One shared promise: every early request waits until the handlers are registered.
let ready: Promise<typeof import('@/mocks/router')> | null = null
function mockRouter() {
  ready ??= (async () => {
    const m = await import('@/mocks/router')
    await import('@/mocks/handlers')
    return m
  })()
  return ready
}

async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  // Mutations always carry an Origin-check header and an idempotency key (UI.md section 5, rule 8).
  const headers: Record<string, string> = { 'X-Y-Client': 'web' }
  if (method !== 'GET') headers['Idempotency-Key'] = idempotencyKey ?? uid('idem')
  if (MOCKS) {
    const m = await mockRouter()
    try {
      return (await m.mockFetch(method, path, body, headers)) as T
    } catch (e) {
      if (e instanceof m.MockHttpError) throw new HttpError(e.status, e.body)
      throw e
    }
  }
  // Real mode: core at VITE_API_URL (or same-origin /api/v1), bearer auth, JSON adapted to the web types.
  const { realRequest } = await import('./real')
  return (await realRequest(method, path, body, headers)) as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, idempotencyKey?: string) => request<T>('POST', path, body ?? {}, idempotencyKey),
}
