/**
 * GET /api/v1/updates?cursor= (packages/schema web.ts UpdatesPage): the viewer's
 * team's per-response summaries plus their own, newest first, keyset paged.
 * Human (web) callers; RLS via db.asUser decides what is visible (I7).
 */
import type { Hono } from 'hono';
import { UpdatesPage, UpdatesQuery, type TurnUpdate } from '@y/schema';
import type { CoreDeps } from '../contracts.js';
import { agentInfos, agentRef } from '../messaging/util.js';
import { authenticate } from '../platform/http.js';
import { fail, iso, parseOr } from '../platform/util.js';

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
  created_at: Date;
  cursor_at: string;
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
      const params: unknown[] = [];
      let where = 'true';
      if (cur) {
        params.push(cur.at, cur.id);
        where = `(t.created_at, t.id::text) < ($1::timestamptz, $2)`;
      }
      params.push(UPDATES_PAGE + 1);
      const r = await tx.query<Row>(
        `select t.id, t.agent_id, t.activity_id, t.repo_key, t.changed, t.building, t.created_at,
                to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
           from public.turn_summaries t
          where ${where}
          order by t.created_at desc, t.id desc
          limit $${params.length}`,
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
          createdAt: iso(x.created_at),
        });
      }
      const last = rows[rows.length - 1];
      return { items, ...(r.rows.length > UPDATES_PAGE && last ? { nextCursor: encodeCursor(last.cursor_at, last.id) } : {}) };
    });
    return c.json(UpdatesPage.parse(page));
  });
}
