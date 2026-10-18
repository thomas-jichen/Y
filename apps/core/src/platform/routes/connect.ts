/** Onboarding: mint an install token (+ agent + install) and poll connection status. Web callers only. */
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { ConnectTokenRequest, type ConnectStatus, type ConnectToken } from '@paceline/schema';
import type { CoreDeps } from '../../contracts.js';
import { authenticate } from '../http.js';
import { hmacHex, iso, mintInstallToken, parseOr, readJson, sha256Hex } from '../util.js';

const HARNESS_SUFFIX: Record<string, string> = { claude_code: 'claude', codex: 'codex', chatgpt: 'chatgpt', other_mcp: 'mcp' };

export function registerConnectRoutes(app: Hono, deps: CoreDeps): void {
  app.post('/api/v1/connect/token', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const body = parseOr(c, ConnectTokenRequest, (await readJson(c)) ?? {});
    if (!body.ok) return body.res;
    const harness = body.data.harness ?? 'claude_code';
    const token = mintInstallToken();
    const pre = await deps.db.asUser(caller.claims, async (tx) => {
      const existing = await tx.query<{ id: string }>(
        `select id from public.agents where owner_user_id = $1 and harness = $2 and variant = 1`,
        [caller.userId, harness],
      );
      const u = await tx.query<{ handle: string }>('select handle from public.users where id = $1', [caller.userId]);
      return { agentId: existing.rows[0]?.id ?? null, userHandle: u.rows[0]?.handle ?? 'agent' };
    });
    let agentId = pre.agentId;
    let newHandle: string | null = null;
    if (!agentId) {
      const suffix = HARNESS_SUFFIX[harness] ?? 'agent';
      const handle = `${pre.userHandle.slice(0, 32 - 1 - suffix.length)}-${suffix}`;
      // handle_registry isn't readable by the API roles; this is a read-only availability check.
      const taken = await deps.db.asService((s) => s.query('select 1 from public.handle_registry where handle = $1', [handle]));
      newHandle = taken.rowCount ? `${handle.slice(0, 27)}-${randomUUID().slice(0, 4)}` : handle;
      agentId = randomUUID();
    }
    const finalAgentId = agentId;
    await deps.db.asUser(caller.claims, async (tx) => {
      if (newHandle) {
        await tx.query('insert into public.agents (id, owner_user_id, handle, harness, variant) values ($1, $2, $3, $4, 1)', [
          finalAgentId,
          caller.userId,
          newHandle,
          harness,
        ]);
      }
      await tx.query(
        `insert into public.installs (id, agent_id, token_hash, machine_label_hash) values ($1, $2, $3, $4)`,
        [randomUUID(), finalAgentId, sha256Hex(token), body.data.machineLabel ? hmacHex(deps.config.hmacKey, `machine:${body.data.machineLabel}`) : null],
      );
    });
    const url = deps.config.publicUrl;
    const res: ConnectToken = {
      token,
      shownOnce: true,
      installCommands: {
        claudeCode: `claude plugin marketplace add paceline/paceline && claude plugin install paceline@paceline && PACELINE_URL=${url} PACELINE_TOKEN=${token} node ~/.claude/plugins/paceline/scripts/dist/connect.mjs`,
        codex: `npx @paceline/cli init codex --url ${url} --token ${token}`,
      },
    };
    return c.json(res);
  });

  app.get('/api/v1/connect/status', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const out = await deps.db.asUser(caller.claims, async (tx) => {
      const first = await tx.query<{ at: Date | null }>(
        `select min(s.created_at) as at from public.sessions s join public.agents a on a.id = s.agent_id where a.owner_user_id = $1`,
        [caller.userId],
      );
      const act = await tx.query<{ id: string }>(
        `select id from public.activities where owner_user_id = $1 order by created_at limit 1`,
        [caller.userId],
      );
      const r: ConnectStatus = {};
      if (first.rows[0]?.at) r.firstHookReceivedAt = iso(first.rows[0].at);
      if (act.rows[0]) r.firstActivityId = `a_${act.rows[0].id}`;
      return r;
    });
    return c.json(out);
  });
}
