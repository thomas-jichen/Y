/**
 * Handle screening (#110). Handles are the only third-party strings allowed on
 * push paths (I3: the P1 wake pointer names the sender agent's handle), so a
 * handle derived from a GitHub login must not read as an instruction to the
 * agent that sees it. The SQL that derives user handles (handle_new_auth_user,
 * y_private.provision_user, dev login through the same trigger) only maps the
 * login to [a-z0-9-]; core screens the result here, with the same label screen
 * as product names (L0 phrase rules on the login as written, with hyphens as
 * spaces and with digits read as letters, plus the instruction-shape check),
 * and falls back to `user-<8 hex>` when it flags:
 * - when core first sees a Supabase user (verifyJwt provisioning) and when dev
 *   login creates a user: the user's handle is replaced;
 * - when connect derives an agent handle (`<user handle>-claude`): a user
 *   handle that does not pass is never used as the base.
 * Ordinary logins (`octocat`, `alice-dev`, `thomas-jichen`) keep their handles.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '@y/db';
import { cleanAsciiLabel } from '../builders/labels.js';
import type { CoreDeps } from '../contracts.js';

/** True when a handle (with or without its `@`) passes the handle screen. */
export function handleScreensClean(handle: string): boolean {
  const bare = handle.replace(/^@/, '');
  return cleanAsciiLabel(bare.toLowerCase());
}

/** The generated handle for a user whose login-derived handle does not pass: `user-<8 hex of the id>`. */
export function fallbackUserHandle(userId: string): string {
  return `user-${userId.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
}

/**
 * Replace the user's handle with a generated one when it does not pass the handle screen
 * (service role). Returns the handle the user has afterwards (null when the user is missing).
 */
export async function screenUserHandle(db: Db, userId: string, log?: CoreDeps['log']): Promise<string | null> {
  return db.asService(async (tx) => {
    const r = await tx.query<{ handle: string }>('select handle::text as handle from public.users where id = $1', [userId]);
    const current = r.rows[0]?.handle;
    if (current === undefined) return null;
    if (handleScreensClean(current)) return current;
    let next = fallbackUserHandle(userId);
    const taken = await tx.query('select 1 from public.handle_registry where handle = $1', [next]);
    if (taken.rowCount) next = `user-${randomBytes(6).toString('hex')}`;
    await tx.query('update public.users set handle = $2 where id = $1', [userId, next]);
    log?.('warn', 'handle derived from the login did not pass the handle screen; replaced', { user_id: userId });
    return next;
  });
}
