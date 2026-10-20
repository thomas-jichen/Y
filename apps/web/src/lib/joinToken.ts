/** Invite links are `<web>/join/<token>` (packages/schema teams.ts InviteToken). */
export const INVITE_TOKEN_RE = /^yti_[A-Za-z0-9_-]{43}$/

/** Where an invite token waits while a signed-out visitor signs in (AppShell resumes it once). */
export const JOIN_TOKEN_KEY = 'y.joinToken'

/** The invite token in a pasted link or bare token, or null. */
export function inviteTokenFrom(input: string): string | null {
  const m = /(?:^|\/join\/)(yti_[A-Za-z0-9_-]{43})(?=$|[/?#\s])/.exec(input.trim())
  return m?.[1] ?? null
}

export function saveJoinToken(token: string): void {
  try {
    sessionStorage.setItem(JOIN_TOKEN_KEY, token)
  } catch {
    /* storage unavailable: the link still works once signed in */
  }
}

/** The saved token, removed as it is read (it resumes at most once). */
export function takeJoinToken(): string | null {
  try {
    const t = sessionStorage.getItem(JOIN_TOKEN_KEY)
    if (t) sessionStorage.removeItem(JOIN_TOKEN_KEY)
    return t && INVITE_TOKEN_RE.test(t) ? t : null
  } catch {
    return null
  }
}
