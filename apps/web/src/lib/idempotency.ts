import { uid } from './hash'

/**
 * One Idempotency-Key per user gesture (UI.md section 5, rule 8). Sending the same payload again
 * before it has gone through (a double click, a retry after a 500 or a network error) reuses the
 * key, so core issues it once. A success, or a different payload, starts a new gesture.
 */
export function gestureKeys(mint: () => string = () => uid('idem')) {
  let pending: { payload: string; key: string } | null = null
  return {
    key(payload: string): string {
      if (!pending || pending.payload !== payload) pending = { payload, key: mint() }
      return pending.key
    },
    done(payload: string): void {
      if (pending?.payload === payload) pending = null
    },
  }
}
