/**
 * The web app shows one team at a time: the viewer's posting team (the team switcher in the repo
 * bar). Feed, posts, threads and review items from the viewer's other teams are left out.
 */
import type { Tx } from '@y/db';

/**
 * SQL: a thread in the selected team. That team's room or a DM tied to it; a DM whose other
 * participants (besides the viewer) are all on the selected team (own agents always are); or a
 * thread tied to no team (stranger requests) or to a product (support with a builder). With no
 * selected team (several teams, none chosen) nothing is left out. `team` and `user` are SQL params.
 */
export function threadInTeamSql(t: string, team: string, user: string): string {
  return `(${team}::uuid is null or ${t}.team_id is null or ${t}.team_id = ${team}::uuid or ${t}.product_id is not null
    or (${t}.kind = 'dm' and not exists (
      select 1 from public.thread_participants tp
       where tp.thread_id = ${t}.id and tp.owner_user_id is distinct from ${user}::uuid
         and not exists (select 1 from public.team_members tm where tm.team_id = ${team}::uuid and tm.user_id = tp.owner_user_id))))`;
}

/**
 * Of these review refs (`a_…`, `h_…`, `m_…`, others), the ones in the selected team. Drafts follow
 * their activity or highlight's team (none: private, shown); message items follow their thread;
 * anything else (stranger DM requests, change requests) is not tied to a team and stays. Run as the
 * service role: a pending stranger message is not readable by its recipient under RLS.
 */
export async function reviewRefsInTeam(tx: Tx, refs: string[], teamId: string | null, userId: string): Promise<Set<string>> {
  if (!teamId) return new Set(refs);
  const keep = new Set(refs.filter((r) => !/^[ahm]_/.test(r)));
  const ids = (p: string) => refs.filter((r) => r.startsWith(p)).map((r) => r.slice(2));
  const ok = (rows: { id: string }[], p: string) => rows.forEach((r) => keep.add(`${p}${r.id}`));
  const a = ids('a_');
  if (a.length) ok((await tx.query<{ id: string }>(`select id from public.activities where id = any($1::text[]) and (team_id is null or team_id is not distinct from $2::uuid)`, [a, teamId])).rows, 'a_');
  const h = ids('h_');
  if (h.length) ok((await tx.query<{ id: string }>(`select id from public.highlights where id = any($1::text[]) and (team_id is null or team_id is not distinct from $2::uuid)`, [h, teamId])).rows, 'h_');
  const m = ids('m_');
  if (m.length) {
    ok((await tx.query<{ id: string }>(
      `select mm.id from public.messages mm join public.threads t on t.id = mm.thread_id
        where mm.id = any($1::text[]) and ${threadInTeamSql('t', '$2', '$3')}`, [m, teamId, userId])).rows, 'm_');
  }
  return keep;
}
