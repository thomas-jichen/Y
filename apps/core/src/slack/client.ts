/**
 * Slack Web API over fetch (no SDK). Every post disables unfurls and mention
 * parsing. Logs carry the method and error code only: never the token or a
 * request body.
 */
export interface SlackPostOpts { timeoutMs?: number }

export interface SlackClient {
  authTest(opts?: SlackPostOpts): Promise<{ teamId: string; teamName: string | null; botUserId: string | null }>;
  /** conversations.open {users} -> channel id (cached per process). */
  openIm(userId: string, opts?: SlackPostOpts): Promise<string>;
  postMessage(m: { channel: string; text: string; blocks?: unknown[]; threadTs?: string }, opts?: SlackPostOpts): Promise<{ channel: string; ts: string }>;
  postEphemeral(m: { channel: string; user: string; text: string; blocks?: unknown[]; threadTs?: string }, opts?: SlackPostOpts): Promise<void>;
  /** chat.update */
  updateMessage(m: { channel: string; ts: string; text: string; blocks?: unknown[] }, opts?: SlackPostOpts): Promise<void>;
}

export class SlackApiError extends Error {
  constructor(readonly method: string, readonly code: string, readonly retryAfterS?: number) {
    super(`slack ${method}: ${code}`);
    this.name = 'SlackApiError';
  }
}

/** Errors retrying cannot fix: the job logs and completes. */
export const PERMANENT_SLACK_ERRORS = new Set([
  'channel_not_found', 'not_in_channel', 'is_archived', 'user_not_found', 'account_inactive', 'cannot_dm_bot',
  'message_not_found', 'cant_update_message', 'invalid_auth', 'not_authed', 'team_access_not_granted',
]);

export function isPermanentSlackError(e: unknown): e is SlackApiError {
  return e instanceof SlackApiError && PERMANENT_SLACK_ERRORS.has(e.code);
}

const API = 'https://slack.com/api/';
const DEFAULT_TIMEOUT_MS = 5000;

export function createFetchSlackClient(token: string, fetchImpl: typeof fetch = globalThis.fetch): SlackClient {
  const ims = new Map<string, string>();
  async function call<T extends Record<string, unknown>>(method: string, body: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const res = await fetchImpl(API + method, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') ?? '');
      throw new SlackApiError(method, 'ratelimited', Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new SlackApiError(method, `http_${res.status}`);
    }
    if (json.ok !== true) throw new SlackApiError(method, typeof json.error === 'string' ? json.error.slice(0, 64) : `http_${res.status}`);
    return json as T;
  }
  const post = { unfurl_links: false, unfurl_media: false, parse: 'none', link_names: false };
  return {
    async authTest(opts) {
      const r = await call<{ team_id?: string; team?: string; user_id?: string }>('auth.test', {}, opts?.timeoutMs);
      return { teamId: String(r.team_id ?? ''), teamName: typeof r.team === 'string' ? r.team.slice(0, 80) : null, botUserId: r.user_id ?? null };
    },
    async openIm(userId, opts) {
      const hit = ims.get(userId);
      if (hit) return hit;
      const r = await call<{ channel?: { id?: string } }>('conversations.open', { users: userId }, opts?.timeoutMs);
      const id = r.channel?.id;
      if (!id) throw new SlackApiError('conversations.open', 'no_channel');
      ims.set(userId, id);
      return id;
    },
    async postMessage(m, opts) {
      const r = await call<{ channel?: string; ts?: string }>('chat.postMessage', {
        channel: m.channel, text: m.text, ...(m.blocks ? { blocks: m.blocks } : {}), ...(m.threadTs ? { thread_ts: m.threadTs } : {}), ...post,
      }, opts?.timeoutMs);
      return { channel: r.channel ?? m.channel, ts: String(r.ts ?? '') };
    },
    async postEphemeral(m, opts) {
      await call('chat.postEphemeral', {
        channel: m.channel, user: m.user, text: m.text, ...(m.blocks ? { blocks: m.blocks } : {}), ...(m.threadTs ? { thread_ts: m.threadTs } : {}), ...post,
      }, opts?.timeoutMs);
    },
    async updateMessage(m, opts) {
      await call('chat.update', { channel: m.channel, ts: m.ts, text: m.text, ...(m.blocks ? { blocks: m.blocks } : {}), parse: 'none', link_names: false }, opts?.timeoutMs);
    },
  };
}
