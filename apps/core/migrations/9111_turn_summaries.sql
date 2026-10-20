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
-- RLS (I7): readable by the author and by members of the author's team while
-- the author still belongs to it. Written only by the service role (no insert,
-- update or delete grant for API roles). Idempotent.

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
  model text not null default '' check (char_length(model) <= 80),
  created_at timestamptz not null default now()
);

-- At most one summary per uploaded chunk.
create unique index if not exists turn_summaries_chunk_idx on public.turn_summaries (session_id, chunk_seq);
create index if not exists turn_summaries_team_idx on public.turn_summaries (team_id, created_at desc, id desc);
create index if not exists turn_summaries_owner_idx on public.turn_summaries (owner_user_id, created_at desc, id desc);

alter table public.turn_summaries enable row level security;

drop policy if exists turn_summaries_select on public.turn_summaries;
create policy turn_summaries_select on public.turn_summaries for select to authenticated
  using (owner_user_id = (select auth.uid())
         or (y_private.is_team_member(team_id)
             and exists (select 1 from public.team_members m
                          where m.team_id = turn_summaries.team_id and m.user_id = turn_summaries.owner_user_id)));

revoke all on public.turn_summaries from public, anon, authenticated;
grant all on public.turn_summaries to service_role;
grant select on public.turn_summaries to authenticated;
