-- apps/core local migration (owner: core updates). Per-response turn summaries
-- (the web's Updates tab).
--
-- After each agent response the plugin uploads one chunk with a redacted
-- digest delta (when capture is on). The worker writes at most one short
-- summary per chunk (`changed`, `building`, each <= 160 chars) from that
-- digest with a small model, screens it (L0 + DLP) and stores it here. The
-- digest itself is never copied: it stays sealed in activity_chunks and is
-- purged there as before (I6). Summaries are distilled text, kept like
-- highlights.
--
-- Sharing is opt-in. A summary carries a team only when its author consented
-- when it was written (public.update_sharing, or the team policy accepted),
-- and teammates see it only while the author still consents, is still on that
-- team, and the activity it came from is not quarantined, rejected or labeled
-- suspicious/malicious (y_private.turn_summary_shared). Turning sharing off
-- hides every earlier summary from the team again.
--
-- RLS (I7): turn_summaries is readable by the author and, as above, by team
-- members; written only by the service role. update_sharing is the person's
-- own row, written only in human context (web or linked Slack, never an
-- agent: I11). Idempotent.

create table if not exists public.turn_summaries (
  id y_private.ulid primary key default y_private.ulid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  owner_user_id uuid not null references public.users (id) on delete cascade,
  team_id uuid references public.teams (id) on delete set null,
  session_id uuid references public.sessions (id) on delete cascade,
  chunk_seq integer not null check (chunk_seq >= 0),
  activity_id y_private.ulid references public.activities (id) on delete set null,
  repo_key y_private.sha256_hex,
  changed text not null check (char_length(changed) between 1 and 160),
  building text not null check (char_length(building) between 1 and 160),
  -- L0 result of the stored text ('clean' or 'warn' / 'sensitive' to show as a label).
  screen_label y_private.label not null default 'clean',
  model text not null default '' check (char_length(model) <= 80),
  created_at timestamptz not null default now()
);

-- At most one summary per uploaded chunk.
create unique index if not exists turn_summaries_chunk_idx on public.turn_summaries (session_id, chunk_seq);
create index if not exists turn_summaries_team_idx on public.turn_summaries (team_id, created_at desc, id desc);
create index if not exists turn_summaries_owner_idx on public.turn_summaries (owner_user_id, created_at desc, id desc);

-- A person's choice to share their agents' turn summaries with their team.
create table if not exists public.update_sharing (
  user_id uuid primary key references public.users (id) on delete cascade,
  share_with_team boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.update_sharing enable row level security;

drop policy if exists update_sharing_select on public.update_sharing;
create policy update_sharing_select on public.update_sharing for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists update_sharing_insert on public.update_sharing;
create policy update_sharing_insert on public.update_sharing for insert to authenticated
  with check (user_id = (select auth.uid()) and y_private.is_human());
drop policy if exists update_sharing_update on public.update_sharing;
create policy update_sharing_update on public.update_sharing for update to authenticated
  using (user_id = (select auth.uid()) and y_private.is_human())
  with check (user_id = (select auth.uid()));

revoke all on public.update_sharing from public, anon, authenticated;
grant all on public.update_sharing to service_role;
grant select on public.update_sharing to authenticated;
grant insert (user_id, share_with_team, updated_at) on public.update_sharing to authenticated;
grant update (share_with_team, updated_at) on public.update_sharing to authenticated;

-- Whether the author of a summary currently shares it with p_team, asked by a
-- member of p_team only (it answers nothing about other teams): the author is
-- still a member, consents (opt-in row or the team policy accepted), and the
-- summary's activity is not held back by moderation. Definer: teammates cannot
-- read the author's update_sharing row or an unpublished activity themselves.
create or replace function y_private.turn_summary_shared(p_owner uuid, p_team uuid, p_activity y_private.ulid)
returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select y_private.is_team_member(p_team)
     and exists (select 1 from public.team_members m
                  where m.team_id = p_team and m.user_id = p_owner
                    and (m.policy_accepted_version is not null
                         or exists (select 1 from public.update_sharing u
                                     where u.user_id = p_owner and u.share_with_team)))
     and (p_activity is null
          or not exists (select 1 from public.activities a
                          where a.id = p_activity
                            and (a.status in ('quarantined', 'rejected')
                                 or a.screen_label in ('suspicious', 'malicious'))))
$fn$;

revoke all on function y_private.turn_summary_shared(uuid, uuid, y_private.ulid) from public, anon;
grant execute on function y_private.turn_summary_shared(uuid, uuid, y_private.ulid) to authenticated, service_role;

alter table public.turn_summaries enable row level security;

drop policy if exists turn_summaries_select on public.turn_summaries;
create policy turn_summaries_select on public.turn_summaries for select to authenticated
  using (owner_user_id = (select auth.uid())
         or (y_private.is_team_member(team_id)
             and y_private.turn_summary_shared(owner_user_id, team_id, activity_id)));

revoke all on public.turn_summaries from public, anon, authenticated;
grant all on public.turn_summaries to service_role;
grant select on public.turn_summaries to authenticated;
