import type { ApiError } from './types'
import { MOCKS } from '@/mocks/enabled'
import { uid } from '@/lib/hash'

export class HttpError extends Error {
  status: number
  body: ApiError
  constructor(status: number, body: ApiError) {
    super(body.error.message)
    this.status = status
    this.body = body
  }
  get code() {
    return this.body.error.code
  }
}

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
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiError | null
    throw new HttpError(res.status, err ?? { error: { code: 'HTTP_' + res.status, message: res.statusText, retryable: res.status >= 500 } })
  }
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, idempotencyKey?: string) => request<T>('POST', path, body ?? {}, idempotencyKey),
}
