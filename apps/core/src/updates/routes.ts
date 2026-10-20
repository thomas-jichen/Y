/**
 * GET /api/v1/updates?cursor= (packages/schema web.ts UpdatesPage): the viewer's
 * team's per-response summaries plus their own, newest first, keyset paged.
 * PUT /api/v1/updates/sharing: the viewer's opt-in to share their agents'
 * summaries with their team. Human (web) callers only; RLS via db.asUser
 * decides what is visible (I7) and the query narrows to the viewer's teams and
 * own rows so it stays on the indexes.
 */
import type { Hono } from 'hono';
import type { Tx } from '@y/db';
import { UpdatesPage, UpdatesQuery, UpdatesSharing, UpdatesSharingUpdate, type Label, type TurnUpdate } from '@y/schema';
import type { CoreDeps } from '../contracts.js';
import { agentInfos, agentRef } from '../messaging/util.js';
import { authenticate } from '../platform/http.js';
import { fail, iso, parseOr, readJson } from '../platform/util.js';

export const UPDATES_PAGE = 30;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Cursors carry created_at at microsecond precision (a JS Date would drop rows in the boundary millisecond). */
function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`).toString('base64url');
}
function decodeCursor(cursor: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!at || !id || Number.isNaN(Date.parse(at)) || !ULID_RE.test(id)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

interface Row {
  id: string;
  agent_id: string;
  activity_id: string | null;
  repo_key: string | null;
  changed: string;
  building: string;
  screen_label: Label;
  created_at: Date;
  cursor_at: string;
}

/** The viewer's sharing setting (own update_sharing row, own memberships; under RLS). */
async function sharingOf(tx: Tx, userId: string): Promise<UpdatesSharing> {
  const r = await tx.query<{ share: boolean | null; accepted: boolean }>(
    `select (select u.share_with_team from public.update_sharing u where u.user_id = $1) as share,
            exists (select 1 from public.team_members m where m.user_id = $1 and m.policy_accepted_version is not null) as accepted`,
    [userId],
  );
  return { shareWithTeam: r.rows[0]?.share === true, teamPolicyAccepted: r.rows[0]?.accepted === true };
}

export function registerUpdatesRoutes(app: Hono, deps: CoreDeps): void {
  app.get('/api/v1/updates', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const q = parseOr(c, UpdatesQuery, c.req.query());
    if (!q.ok) return q.res;
    const cur = q.data.cursor ? decodeCursor(q.data.cursor) : null;
    if (q.data.cursor && !cur) return fail(c, 'VALIDATION', 'invalid cursor');
    const page = await deps.db.asUser(caller.claims, async (tx) => {
      // Two index-shaped branches (team rows, then own rows outside those teams), each keyset-limited,
      // merged and limited again. RLS still guards every row.
      const params: unknown[] = [caller.userId, UPDATES_PAGE + 1];
      let keyset = '';
      if (cur) {
        params.push(cur.at, cur.id);
        keyset = `and (t.created_at, t.id::text) < ($3::timestamptz, $4)`;
      }
      const cols = `t.id, t.agent_id, t.activity_id, t.repo_key, t.changed, t.building, t.screen_label, t.created_at,
                    to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at`;
      const r = await tx.query<Row>(
        `with my_teams as (select m.team_id from public.team_members m where m.user_id = $1)
         select * from (
           (select ${cols} from public.turn_summaries t
             where t.team_id in (select team_id from my_teams) ${keyset}
             order by t.created_at desc, t.id desc limit $2)
           union all
           (select ${cols} from public.turn_summaries t
             where t.owner_user_id = $1 and (t.team_id is null or t.team_id not in (select team_id from my_teams)) ${keyset}
             order by t.created_at desc, t.id desc limit $2)
         ) u
         order by u.created_at desc, u.id desc
         limit $2`,
        params,
      );
      const rows = r.rows.slice(0, UPDATES_PAGE);
      const agents = await agentInfos(tx, [...new Set(rows.map((x) => x.agent_id))]);
      const items: TurnUpdate[] = [];
      for (const x of rows) {
        const a = agents.get(x.agent_id);
        if (!a) continue;
        items.push({
          id: `tu_${x.id}`,
          agent: agentRef(a),
          ...(x.activity_id ? { activityId: `a_${x.activity_id}` } : {}),
          ...(x.repo_key ? { repoKey: x.repo_key } : {}),
          changed: x.changed,
          building: x.building,
          ...(x.screen_label !== 'clean' ? { label: x.screen_label } : {}),
          createdAt: iso(x.created_at),
        });
      }
      const last = rows[rows.length - 1];
      return {
        items,
        ...(r.rows.length > UPDATES_PAGE && last ? { nextCursor: encodeCursor(last.cursor_at, last.id) } : {}),
        ...(cur ? {} : { sharing: await sharingOf(tx, caller.userId) }),
      };
    });
    return c.json(UpdatesPage.parse(page));
  });

  // Opt in or out of sharing turn summaries with the team. A human gesture in the web app (I11);
  // RLS also requires human context for the write.
  app.put('/api/v1/updates/sharing', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const body = parseOr(c, UpdatesSharingUpdate, await readJson(c));
    if (!body.ok) return body.res;
    const out = await deps.db.asUser(caller.claims, async (tx) => {
      await tx.query(
        `insert into public.update_sharing (user_id, share_with_team, updated_at) values ($1, $2, now())
         on conflict (user_id) do update set share_with_team = excluded.share_with_team, updated_at = now()`,
        [caller.userId, body.data.shareWithTeam],
      );
      return sharingOf(tx, caller.userId);
    });
    return c.json(UpdatesSharing.parse(out));
  });
}
