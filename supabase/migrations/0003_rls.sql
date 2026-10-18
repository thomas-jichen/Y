-- 0003_rls.sql
--
-- Row-level security on EVERY table (invariant I7), the helper functions the
-- policies use, and explicit grants. Nothing is reachable by default:
-- everything is revoked from PUBLIC, anon and authenticated first, then
-- granted table by table (and column by column for updates).
--
-- Request context (set by @paceline/db asUser(), or by Supabase from a JWT):
--   auth.uid()              the user (auth.users.id)
--   claims.agent_id         present when an agent acts (install token, MCP)
--   claims.via              'web' | 'slack' | 'install' | 'oauth'
--
-- Human context = no agent_id claim AND via in ('web', 'slack'). Human-only
-- writes (DM permissions, approvals, follows, friendships, team admin,
-- owner instructions, visibility changes) require it, so neither an agent
-- token nor a raw Supabase JWT (which carries no `via`) can perform them.
-- Core MUST set via='web' for browser sessions and via='slack' for linked
-- Slack actions, and agent_id (+ via='install' or 'oauth') for agent calls.
--
-- Agent context sees strictly less than human context: e.g. quarantined and
-- request_pending messages, and 'request' threads, are visible to the
-- recipient's human only.
--
-- service_role has BYPASSRLS (worker jobs, Slack webhooks). It is the only
-- role that can touch jobs, events, rate_buckets, signing_keys, audit_log,
-- verdicts, wake_ledger and the Slack plumbing tables.
--
-- RULE FOR LATER MIGRATIONS: every new table must `enable row level
-- security`, revoke from anon/authenticated and grant explicitly. The DO
-- block at the end of this file (and supabase/tests/00_schema.sql) fail when
-- a table in public or paceline_private lacks RLS.

-- ================================================================ claim helpers

create or replace function paceline_private.jwt_claim(p_name text) returns text
language sql stable parallel safe
set search_path = ''
as $fn$
  select nullif(auth.jwt() ->> p_name, '')
$fn$;
comment on function paceline_private.jwt_claim(text) is 'A request.jwt.claims value, or null when absent/empty.';

-- The acting agent from claims. A malformed agent_id maps to the nil UUID
-- (which owns nothing) rather than to null, so it can never pass as human.
create or replace function paceline_private.acting_agent_id() returns uuid
language sql stable parallel safe
set search_path = ''
as $fn$
  select case
    when c is null then null
    when c ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then c::uuid
    else '00000000-0000-0000-0000-000000000000'::uuid
  end
  from (select paceline_private.jwt_claim('agent_id') as c) s
$fn$;

create or replace function paceline_private.is_agent_context() returns boolean
language sql stable parallel safe
set search_path = ''
as $fn$
  select paceline_private.jwt_claim('agent_id') is not null
      or coalesce(paceline_private.jwt_claim('via') in ('install', 'oauth'), false)
$fn$;

-- A human acting through the web app or a linked Slack user (I4, I5, I11).
create or replace function paceline_private.is_human() returns boolean
language sql stable parallel safe
set search_path = ''
as $fn$
  select auth.uid() is not null
     and paceline_private.jwt_claim('agent_id') is null
     and coalesce(paceline_private.jwt_claim('via') in ('web', 'slack'), false)
$fn$;

-- True for service_role and superusers/BYPASSRLS roles (migrations, worker).
-- Only meaningful in SECURITY INVOKER code (definer code runs as the owner).
create or replace function paceline_private.is_service() returns boolean
language sql stable parallel safe
set search_path = ''
as $fn$
  select current_user = 'service_role'
      or exists (select 1 from pg_catalog.pg_roles r
                 where r.rolname = current_user and (r.rolsuper or r.rolbypassrls))
$fn$;

-- ============================================================ membership helpers
-- SECURITY DEFINER so policies can consult membership without recursing into
-- the RLS of the membership tables. Each answers a question about the CALLER
-- only (auth.uid()), never about arbitrary users.

create or replace function paceline_private.is_team_member(p_team_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_team_id is not null and exists (
    select 1 from public.team_members m where m.team_id = p_team_id and m.user_id = auth.uid())
$fn$;

create or replace function paceline_private.is_team_admin(p_team_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_team_id is not null and exists (
    select 1 from public.team_members m
    where m.team_id = p_team_id and m.user_id = auth.uid() and m.role in ('owner', 'admin'))
$fn$;

create or replace function paceline_private.is_team_owner(p_team_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_team_id is not null and exists (
    select 1 from public.team_members m
    where m.team_id = p_team_id and m.user_id = auth.uid() and m.role = 'owner')
$fn$;

create or replace function paceline_private.is_org_member(p_org_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_org_id is not null and exists (
    select 1 from public.org_members m where m.org_id = p_org_id and m.user_id = auth.uid())
$fn$;

create or replace function paceline_private.is_org_admin(p_org_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_org_id is not null and exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = auth.uid() and m.role in ('owner', 'admin'))
$fn$;

-- Verified GitHub access to the repo behind `p_repo_key` (a per-team HMAC).
create or replace function paceline_private.can_see_repo(p_repo_key text) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_repo_key is not null and exists (
    select 1 from public.repo_access r
    where r.repo_key = p_repo_key and r.user_id = auth.uid()
      and r.verified_at is not null and (r.expires_at is null or r.expires_at > now()))
$fn$;

create or replace function paceline_private.owns_agent(p_agent_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_agent_id is not null and exists (
    select 1 from public.agents a where a.id = p_agent_id and a.owner_user_id = auth.uid())
$fn$;

-- The caller may act as `p_agent_id`: they own it, and if an agent is acting
-- it is this one (an agent token cannot act as its owner's other agents).
create or replace function paceline_private.agent_ok(p_agent_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select paceline_private.owns_agent(p_agent_id)
     and (paceline_private.acting_agent_id() is null or paceline_private.acting_agent_id() = p_agent_id)
$fn$;

-- The caller participates in the thread: through any participant they own
-- (their agents or themselves), or, in agent context, only through the
-- acting agent's own participant row (a sibling agent's DMs stay private).
create or replace function paceline_private.is_thread_participant(p_thread_id text) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_thread_id is not null and exists (
    select 1 from public.thread_participants p
    where p.thread_id = p_thread_id
      and p.owner_user_id = auth.uid()
      and (paceline_private.acting_agent_id() is null
           or (p.p_kind = 'agent' and p.p_id = paceline_private.acting_agent_id())))
$fn$;

create or replace function paceline_private.thread_created_by_me(p_thread_id text) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_thread_id is not null and exists (
    select 1 from public.threads t where t.id = p_thread_id and t.created_by_user_id = auth.uid())
$fn$;

create or replace function paceline_private.message_sent_by_me(p_message_id text) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_message_id is not null and exists (
    select 1 from public.messages m
    where m.id = p_message_id and m.sender_owner_id = auth.uid()
      and (paceline_private.acting_agent_id() is null or m.sender_id = paceline_private.acting_agent_id()))
$fn$;

-- Whether the caller's own agent accepts owner instructions (false for
-- agents the caller does not own, so it reveals nothing about others).
create or replace function paceline_private.remote_instructions_on(p_agent_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select coalesce((select s.remote_instructions
                   from public.agent_settings s
                   join public.agents a on a.id = s.agent_id
                   where s.agent_id = p_agent_id and a.owner_user_id = auth.uid()), false)
$fn$;

create or replace function paceline_private.product_team(p_product_id text) returns uuid
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p.owner_team_id from public.products p where p.id = p_product_id
$fn$;

create or replace function paceline_private.user_is_public(p_user_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select exists (select 1 from public.users u where u.id = p_user_id and u.public_profile and u.status = 'active')
$fn$;

-- The caller shares a team with `p_user_id` (presence is team-only).
create or replace function paceline_private.shares_team_with(p_user_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select exists (
    select 1 from public.team_members a
    join public.team_members b on b.team_id = a.team_id
    where a.user_id = auth.uid() and b.user_id = p_user_id)
$fn$;

-- Whether the caller may see `p_user_id`'s profile: self, public profiles,
-- teammates, org co-members, friends (incl. pending requests either way),
-- thread co-participants, and owners of agents the caller follows.
create or replace function paceline_private.user_is_visible(p_user_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_user_id is not null and (
       p_user_id = auth.uid()
    or paceline_private.user_is_public(p_user_id)
    or (auth.uid() is not null and (
         paceline_private.shares_team_with(p_user_id)
      or exists (select 1 from public.org_members a join public.org_members b on b.org_id = a.org_id
                 where a.user_id = auth.uid() and b.user_id = p_user_id)
      or exists (select 1 from public.friendships f
                 where (f.requester_id = auth.uid() and f.addressee_id = p_user_id)
                    or (f.addressee_id = auth.uid() and f.requester_id = p_user_id))
      or exists (select 1 from public.thread_participants a join public.thread_participants b on b.thread_id = a.thread_id
                 where a.owner_user_id = auth.uid() and b.owner_user_id = p_user_id)
      or exists (select 1 from public.follows f join public.agents ag on ag.id = f.agent_id
                 where f.follower_user_id = auth.uid() and ag.owner_user_id = p_user_id)))
  )
$fn$;

-- Whether `p_agent_id` is an agent participant of the thread (for the
-- assignee guard: assignments may only name a participant agent).
create or replace function paceline_private.is_agent_participant(p_thread_id text, p_agent_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_thread_id is not null and p_agent_id is not null and exists (
    select 1 from public.thread_participants p
    where p.thread_id = p_thread_id and p.p_kind = 'agent' and p.p_id = p_agent_id)
$fn$;

-- Whether the caller may address realtime events to `p_user_id`
-- (api.emit_event): themself, teammates, org co-members, accepted friends and
-- thread co-participants. Stricter than user_is_visible (no public profiles,
-- no pending friend requests, no follows), so a user context can never ping
-- arbitrary users.
create or replace function paceline_private.can_notify_user(p_user_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_user_id is not null and auth.uid() is not null and (
       p_user_id = auth.uid()
    or paceline_private.shares_team_with(p_user_id)
    or exists (select 1 from public.org_members a join public.org_members b on b.org_id = a.org_id
               where a.user_id = auth.uid() and b.user_id = p_user_id)
    or exists (select 1 from public.friendships f
               where f.state = 'accepted'
                 and ((f.requester_id = auth.uid() and f.addressee_id = p_user_id)
                      or (f.addressee_id = auth.uid() and f.requester_id = p_user_id)))
    or exists (select 1 from public.thread_participants a join public.thread_participants b on b.thread_id = a.thread_id
               where a.owner_user_id = auth.uid() and b.owner_user_id = p_user_id))
$fn$;

-- ============================================================ visibility helpers

-- The private | repo | team | public rule, without status filtering:
--   public  everyone (anon included)
--   team    the owner, and members of team_id
--   repo    the owner, and members of team_id with verified access to repo_key
--   private the owner only
create or replace function paceline_private.visible_content(
  p_owner uuid, p_team_id uuid, p_visibility text, p_repo_key text
) returns boolean
language sql stable parallel safe
set search_path = ''
as $fn$
  select coalesce(case p_visibility
    when 'public' then true
    when 'team' then p_owner = auth.uid() or paceline_private.is_team_member(p_team_id)
    when 'repo' then p_owner = auth.uid()
                     or (paceline_private.is_team_member(p_team_id) and paceline_private.can_see_repo(p_repo_key))
    when 'private' then p_owner = auth.uid()
    else false
  end, false)
$fn$;

-- An activity is visible to its owner in any status, and to others only when
-- published, screened allow|label, and permitted by its visibility.
create or replace function paceline_private.visible_activity(a public.activities) returns boolean
language sql stable parallel safe
set search_path = ''
as $fn$
  select coalesce(a.owner_user_id = auth.uid(), false)
      or (a.status = 'published'
          and a.screen_action in ('allow', 'label')
          and paceline_private.visible_content(a.owner_user_id, a.team_id, a.visibility, a.repo_key))
$fn$;

-- The same rule for highlights (status 'active').
create or replace function paceline_private.visible_highlight(h public.highlights) returns boolean
language sql stable parallel safe
set search_path = ''
as $fn$
  select coalesce(h.owner_user_id = auth.uid(), false)
      or (h.status = 'active'
          and h.screen_action in ('allow', 'label')
          and paceline_private.visible_content(h.owner_user_id, h.team_id, h.visibility, h.repo_key))
$fn$;

-- ======================================================================= enable RLS

alter table public.users enable row level security;
alter table public.user_private enable row level security;
alter table public.handle_registry enable row level security;
alter table public.teams enable row level security;
alter table public.team_secrets enable row level security;
alter table public.team_members enable row level security;
alter table public.team_policies enable row level security;
alter table public.team_invites enable row level security;
alter table public.agents enable row level security;
alter table public.agent_settings enable row level security;
alter table public.agent_presence enable row level security;
alter table public.installs enable row level security;
alter table public.realtime_channels enable row level security;
alter table public.follows enable row level security;
alter table public.friendships enable row level security;
alter table public.oauth_grants enable row level security;
alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.org_teams enable row level security;
alter table public.repo_access enable row level security;
alter table public.verdicts enable row level security;
alter table public.kill_switches enable row level security;
alter table public.signing_keys enable row level security;
alter table public.audit_log enable row level security;
alter table public.segments enable row level security;
alter table public.sessions enable row level security;
alter table public.session_leases enable row level security;
alter table public.setup_versions enable row level security;
alter table public.shared_components enable row level security;
alter table public.setup_components enable row level security;
alter table public.activities enable row level security;
alter table public.activity_chunks enable row level security;
alter table public.highlights enable row level security;
alter table public.highlight_errors enable row level security;
alter table public.daily_rollups enable row level security;
alter table public.setup_reviews enable row level security;
alter table public.segment_efforts enable row level security;
alter table public.segment_stats enable row level security;
alter table public.personal_records enable row level security;
alter table public.kudos enable row level security;
alter table public.outcome_events enable row level security;
alter table public.content_exposures enable row level security;
alter table public.products enable row level security;
alter table public.product_claims enable row level security;
alter table public.threads enable row level security;
alter table public.thread_participants enable row level security;
alter table public.messages enable row level security;
alter table public.message_deliveries enable row level security;
alter table public.owner_instructions enable row level security;
alter table public.dm_permissions enable row level security;
alter table public.work_claims enable row level security;
alter table public.wake_ledger enable row level security;
alter table public.events enable row level security;
alter table public.review_items enable row level security;
alter table public.reports enable row level security;
alter table public.setup_suggestions enable row level security;
alter table public.change_requests enable row level security;
alter table public.adoptions enable row level security;
alter table public.builder_tasks enable row level security;
alter table public.jobs enable row level security;
alter table public.rate_buckets enable row level security;
alter table public.notification_prefs enable row level security;
alter table public.slack_installations enable row level security;
alter table public.slack_identity_links enable row level security;
alter table public.slack_link_tokens enable row level security;
alter table public.thread_bridges enable row level security;
alter table public.slack_events_seen enable row level security;
alter table public.prompt_feedback enable row level security;

-- ========================================================================= policies
-- `(select auth.uid())` lets Postgres evaluate the uid once per statement.
-- Tables without policies (handle_registry, verdicts, signing_keys,
-- audit_log, wake_ledger, events, jobs, rate_buckets, slack_installations,
-- slack_link_tokens, thread_bridges, slack_events_seen) are service-only.

-- ---------------------------------------------------------------- identity

create policy users_select on public.users for select to anon, authenticated
  using (id = (select auth.uid()) or (status = 'active' and paceline_private.user_is_visible(id)));
create policy users_update_self on public.users for update to authenticated
  using (id = (select auth.uid()) and paceline_private.is_human())
  with check (id = (select auth.uid()));

create policy user_private_select_self on public.user_private for select to authenticated
  using (user_id = (select auth.uid()));

create policy teams_select on public.teams for select to authenticated
  using (paceline_private.is_team_member(id));
create policy teams_insert on public.teams for insert to authenticated
  with check (created_by = (select auth.uid()) and paceline_private.is_human() and not is_eval);
create policy teams_update on public.teams for update to authenticated
  using (paceline_private.is_team_admin(id) and paceline_private.is_human())
  with check (paceline_private.is_team_admin(id));

create policy team_secrets_select on public.team_secrets for select to authenticated
  using (paceline_private.is_team_member(team_id));

create policy team_members_select on public.team_members for select to authenticated
  using (paceline_private.is_team_member(team_id));
create policy team_members_insert on public.team_members for insert to authenticated
  with check (paceline_private.is_team_admin(team_id) and paceline_private.is_human());
create policy team_members_update on public.team_members for update to authenticated
  using ((user_id = (select auth.uid()) or paceline_private.is_team_admin(team_id)) and paceline_private.is_human())
  with check (user_id = (select auth.uid()) or paceline_private.is_team_admin(team_id));
create policy team_members_delete on public.team_members for delete to authenticated
  using ((user_id = (select auth.uid()) or paceline_private.is_team_admin(team_id)) and paceline_private.is_human());

create policy team_policies_select on public.team_policies for select to authenticated
  using (paceline_private.is_team_member(team_id));
create policy team_policies_insert on public.team_policies for insert to authenticated
  with check (paceline_private.is_team_admin(team_id) and created_by = (select auth.uid()) and paceline_private.is_human());

create policy team_invites_select on public.team_invites for select to authenticated
  using (paceline_private.is_team_admin(team_id));
create policy team_invites_insert on public.team_invites for insert to authenticated
  with check (paceline_private.is_team_admin(team_id) and created_by = (select auth.uid())
              and paceline_private.is_human() and uses = 0 and revoked_at is null);
create policy team_invites_update on public.team_invites for update to authenticated
  using (paceline_private.is_team_admin(team_id) and paceline_private.is_human())
  with check (paceline_private.is_team_admin(team_id));

create policy agents_select on public.agents for select to anon, authenticated
  using (owner_user_id = (select auth.uid()) or paceline_private.user_is_visible(owner_user_id));
create policy agents_insert on public.agents for insert to authenticated
  with check (owner_user_id = (select auth.uid()) and paceline_private.is_human() and status = 'active');
create policy agents_update on public.agents for update to authenticated
  using (owner_user_id = (select auth.uid()) and paceline_private.is_human())
  with check (owner_user_id = (select auth.uid()));

create policy agent_settings_select on public.agent_settings for select to authenticated
  using (paceline_private.agent_ok(agent_id));
create policy agent_settings_update on public.agent_settings for update to authenticated
  using (paceline_private.owns_agent(agent_id) and paceline_private.is_human())
  with check (paceline_private.owns_agent(agent_id));

create policy agent_presence_select on public.agent_presence for select to authenticated
  using (
    paceline_private.owns_agent(agent_id)
    or exists (select 1 from public.agents a
               where a.id = agent_presence.agent_id
                 and (paceline_private.shares_team_with(a.owner_user_id)
                      or exists (select 1 from public.thread_participants p
                                 where p.p_kind = 'agent' and p.p_id = a.id
                                   and paceline_private.is_thread_participant(p.thread_id)))));
create policy agent_presence_update on public.agent_presence for update to authenticated
  using (paceline_private.agent_ok(agent_id))
  with check (paceline_private.agent_ok(agent_id));

create policy installs_select on public.installs for select to authenticated
  using (paceline_private.owns_agent(agent_id));
create policy installs_insert on public.installs for insert to authenticated
  with check (paceline_private.owns_agent(agent_id) and paceline_private.is_human() and revoked_at is null);
create policy installs_update on public.installs for update to authenticated
  using (paceline_private.agent_ok(agent_id))
  with check (paceline_private.agent_ok(agent_id));

create policy realtime_channels_select_owner on public.realtime_channels for select to authenticated
  using ((owner_kind = 'user' and owner_id = (select auth.uid()) and not paceline_private.is_agent_context())
         or (owner_kind = 'agent' and paceline_private.agent_ok(owner_id)));

create policy follows_select on public.follows for select to authenticated
  using (follower_user_id = (select auth.uid()) or paceline_private.owns_agent(agent_id));
create policy follows_insert on public.follows for insert to authenticated
  with check (follower_user_id = (select auth.uid()) and paceline_private.is_human());
create policy follows_delete on public.follows for delete to authenticated
  using (follower_user_id = (select auth.uid()) and paceline_private.is_human());

create policy friendships_select on public.friendships for select to authenticated
  using (requester_id = (select auth.uid()) or addressee_id = (select auth.uid()));
create policy friendships_insert on public.friendships for insert to authenticated
  with check (requester_id = (select auth.uid()) and state = 'pending' and paceline_private.is_human());
-- Only the addressee answers, and only a pending request.
create policy friendships_respond on public.friendships for update to authenticated
  using (addressee_id = (select auth.uid()) and state = 'pending' and paceline_private.is_human())
  with check (addressee_id = (select auth.uid()) and state in ('accepted', 'declined'));
create policy friendships_delete on public.friendships for delete to authenticated
  using ((requester_id = (select auth.uid()) or addressee_id = (select auth.uid())) and paceline_private.is_human());

create policy oauth_grants_select on public.oauth_grants for select to authenticated
  using (user_id = (select auth.uid()));
create policy oauth_grants_insert on public.oauth_grants for insert to authenticated
  with check (user_id = (select auth.uid()) and paceline_private.is_human());
create policy oauth_grants_update on public.oauth_grants for update to authenticated
  using (user_id = (select auth.uid()) and paceline_private.is_human())
  with check (user_id = (select auth.uid()));
create policy oauth_grants_delete on public.oauth_grants for delete to authenticated
  using (user_id = (select auth.uid()) and paceline_private.is_human());

-- ---------------------------------------------------------------------- orgs

create policy orgs_select on public.orgs for select to authenticated
  using (paceline_private.is_org_member(id));
create policy orgs_insert on public.orgs for insert to authenticated
  with check (created_by = (select auth.uid()) and paceline_private.is_human());
create policy orgs_update on public.orgs for update to authenticated
  using (paceline_private.is_org_admin(id) and paceline_private.is_human())
  with check (paceline_private.is_org_admin(id));

create policy org_members_select on public.org_members for select to authenticated
  using (paceline_private.is_org_member(org_id));
create policy org_members_insert on public.org_members for insert to authenticated
  with check (paceline_private.is_org_admin(org_id) and paceline_private.is_human());
create policy org_members_update on public.org_members for update to authenticated
  using ((user_id = (select auth.uid()) or paceline_private.is_org_admin(org_id)) and paceline_private.is_human())
  with check (user_id = (select auth.uid()) or paceline_private.is_org_admin(org_id));
create policy org_members_delete on public.org_members for delete to authenticated
  using ((user_id = (select auth.uid()) or paceline_private.is_org_admin(org_id)) and paceline_private.is_human());

create policy org_teams_select on public.org_teams for select to authenticated
  using (paceline_private.is_org_member(org_id) or paceline_private.is_team_member(team_id));
create policy org_teams_insert on public.org_teams for insert to authenticated
  with check (paceline_private.is_org_admin(org_id) and paceline_private.is_team_admin(team_id)
              and paceline_private.is_human());
create policy org_teams_delete on public.org_teams for delete to authenticated
  using ((paceline_private.is_org_admin(org_id) or paceline_private.is_team_admin(team_id))
         and paceline_private.is_human());

create policy repo_access_select_self on public.repo_access for select to authenticated
  using (user_id = (select auth.uid()));

-- ------------------------------------------------------------------- safety

-- Kill switches are public: every client polls them (PLAN §10).
create policy kill_switches_select on public.kill_switches for select to anon, authenticated
  using (true);

-- ------------------------------------------------------------------- capture

create policy sessions_select on public.sessions for select to authenticated
  using (paceline_private.agent_ok(agent_id));
-- Foreign keys a caller sets must point at their own objects (FK checks
-- bypass RLS, so the policies check ownership explicitly).
create policy sessions_insert on public.sessions for insert to authenticated
  with check (paceline_private.agent_ok(agent_id)
              and (install_id is null or exists (select 1 from public.installs i
                                                 where i.id = sessions.install_id and i.agent_id = sessions.agent_id)));
create policy sessions_update on public.sessions for update to authenticated
  using (paceline_private.agent_ok(agent_id))
  with check (paceline_private.agent_ok(agent_id));

create policy session_leases_select on public.session_leases for select to authenticated
  using (paceline_private.agent_ok(agent_id));
create policy session_leases_insert on public.session_leases for insert to authenticated
  with check (paceline_private.agent_ok(agent_id)
              and (install_id is null or exists (select 1 from public.installs i
                                                 where i.id = session_leases.install_id and i.agent_id = session_leases.agent_id)));
create policy session_leases_update on public.session_leases for update to authenticated
  using (paceline_private.agent_ok(agent_id))
  with check (paceline_private.agent_ok(agent_id)
              and (install_id is null or exists (select 1 from public.installs i
                                                 where i.id = session_leases.install_id and i.agent_id = session_leases.agent_id)));
create policy session_leases_delete on public.session_leases for delete to authenticated
  using (paceline_private.agent_ok(agent_id));

create policy activity_chunks_select on public.activity_chunks for select to authenticated
  using (exists (select 1 from public.sessions s
                 where s.id = activity_chunks.session_id and paceline_private.agent_ok(s.agent_id)));
create policy activity_chunks_insert on public.activity_chunks for insert to authenticated
  with check (exists (select 1 from public.sessions s
                      where s.id = activity_chunks.session_id and paceline_private.agent_ok(s.agent_id)
                        and (activity_chunks.activity_id is null
                             or exists (select 1 from public.activities a
                                        where a.id = activity_chunks.activity_id and a.agent_id = s.agent_id)))
              and distilled_at is null and digest_purged_at is null);

-- --------------------------------------------------------------- activities

create policy activities_select on public.activities for select to anon, authenticated
  using (paceline_private.visible_activity(activities));
-- Agents and humans create activities only in their initial state; the
-- worker screens and publishes. Public visibility is never set directly.
create policy activities_insert on public.activities for insert to authenticated
  with check (
    owner_user_id = (select auth.uid())
    and paceline_private.agent_ok(agent_id)
    and status = 'open'
    and source in ('captured', 'agent_reported')
    and visibility in ('private', 'repo', 'team')
    and (team_id is null or paceline_private.is_team_member(team_id))
    and (session_id is null or exists (select 1 from public.sessions s
                                       where s.id = activities.session_id and s.agent_id = activities.agent_id))
    and (setup_version_id is null or exists (select 1 from public.setup_versions v
                                             where v.id = activities.setup_version_id and v.agent_id = activities.agent_id))
    and screen_action is null and verdict_id is null and published_at is null);
-- Owner edits from the web: visibility (never to public) and archiving.
-- Transitions are checked by the guard trigger in 0005.
create policy activities_update_owner on public.activities for update to authenticated
  using (owner_user_id = (select auth.uid()) and paceline_private.is_human())
  with check (owner_user_id = (select auth.uid())
              and (team_id is null or paceline_private.is_team_member(team_id)));

create policy highlights_select on public.highlights for select to anon, authenticated
  using (paceline_private.visible_highlight(highlights));
create policy highlights_update_owner on public.highlights for update to authenticated
  using (owner_user_id = (select auth.uid()) and paceline_private.is_human())
  with check (owner_user_id = (select auth.uid()));

create policy highlight_errors_select on public.highlight_errors for select to anon, authenticated
  using (exists (select 1 from public.highlights h where h.id = highlight_errors.highlight_id));

create policy daily_rollups_select on public.daily_rollups for select to authenticated
  using (paceline_private.owns_agent(agent_id) or paceline_private.is_team_member(team_id));

-- ------------------------------------------------------------------- setups

create policy setup_versions_select on public.setup_versions for select to anon, authenticated
  using (paceline_private.owns_agent(agent_id)
         or exists (select 1 from public.activities a
                    where a.setup_version_id = setup_versions.id and a.agent_id = setup_versions.agent_id));
create policy setup_versions_insert on public.setup_versions for insert to authenticated
  with check (paceline_private.agent_ok(agent_id));

create policy setup_components_select on public.setup_components for select to anon, authenticated
  using (exists (select 1 from public.setup_versions v where v.id = setup_components.setup_version_id));
create policy setup_components_insert on public.setup_components for insert to authenticated
  with check (exists (select 1 from public.setup_versions v
                      where v.id = setup_components.setup_version_id and paceline_private.agent_ok(v.agent_id)));

create policy shared_components_select on public.shared_components for select to anon, authenticated
  using (owner_user_id = (select auth.uid())
         or (status = 'active' and screen_action in ('allow', 'label')
             and paceline_private.visible_content(owner_user_id, team_id, visibility, null)));
-- Opt-in sharing (/paceline:share-skill or the web toggle) starts screening.
create policy shared_components_insert on public.shared_components for insert to authenticated
  with check (owner_user_id = (select auth.uid())
              and paceline_private.agent_ok(author_agent_id)
              and status = 'screening' and visibility in ('private', 'team')
              and (team_id is null or paceline_private.is_team_member(team_id))
              and screen_action is null and verdict_id is null and static_outcome is null);
create policy shared_components_update_owner on public.shared_components for update to authenticated
  using (owner_user_id = (select auth.uid()) and paceline_private.is_human())
  with check (owner_user_id = (select auth.uid()));

create policy setup_reviews_select on public.setup_reviews for select to anon, authenticated
  using (owner_user_id = (select auth.uid())
         or (status = 'active' and screen_action in ('allow', 'label')
             and exists (select 1 from public.shared_components c where c.id = setup_reviews.component_id)));
create policy setup_reviews_insert on public.setup_reviews for insert to authenticated
  with check (owner_user_id = (select auth.uid()) and paceline_private.agent_ok(reviewer_agent_id)
              and status = 'screening' and screen_action is null and verdict_id is null);

-- ------------------------------------------------------------------ ranking

create policy segments_select on public.segments for select to anon, authenticated
  using (true);

create policy segment_efforts_select on public.segment_efforts for select to authenticated
  using (exists (select 1 from public.activities a where a.id = segment_efforts.activity_id));

-- Public rows are k-anonymous aggregates (the worker writes them only with
-- >= 5 owners); team rows are for that team.
create policy segment_stats_select on public.segment_stats for select to anon, authenticated
  using (scope = 'public' or paceline_private.is_team_member(team_id));

create policy personal_records_select on public.personal_records for select to authenticated
  using (paceline_private.owns_agent(agent_id)
         or exists (select 1 from public.activities a where a.id = personal_records.activity_id));

create policy kudos_select on public.kudos for select to authenticated
  using (exists (select 1 from public.activities a where a.id = kudos.activity_id));
create policy kudos_insert on public.kudos for insert to authenticated
  with check (user_id = (select auth.uid()) and paceline_private.is_human()
              and exists (select 1 from public.activities a where a.id = kudos.activity_id));
create policy kudos_delete on public.kudos for delete to authenticated
  using (user_id = (select auth.uid()) and paceline_private.is_human());

-- Reported outcomes carry weight 0 (table check); measured ones come from the worker.
create policy outcome_events_select on public.outcome_events for select to authenticated
  using (actor_owner_id = (select auth.uid()));
create policy outcome_events_insert on public.outcome_events for insert to authenticated
  with check (actor_owner_id = (select auth.uid()) and source = 'reported' and weight = 0
              and (session_id is null or exists (select 1 from public.sessions s where s.id = outcome_events.session_id)));

create policy content_exposures_select on public.content_exposures for select to authenticated
  using (paceline_private.agent_ok(agent_id));
create policy content_exposures_insert on public.content_exposures for insert to authenticated
  with check (paceline_private.agent_ok(agent_id)
              and (session_id is null or exists (select 1 from public.sessions s
                                                 where s.id = content_exposures.session_id
                                                   and s.agent_id = content_exposures.agent_id))
              and case content_kind
                    when 'highlight' then exists (select 1 from public.highlights h
                                                  where 'h_' || h.id = content_exposures.content_id)
                    when 'activity' then exists (select 1 from public.activities a
                                                 where 'a_' || a.id = content_exposures.content_id)
                    when 'component' then exists (select 1 from public.shared_components c
                                                  where 'cmp_' || c.id = content_exposures.content_id)
                    when 'suggestion' then exists (select 1 from public.setup_suggestions g
                                                   where 'sg_' || g.id = content_exposures.content_id)
                    else false
                  end);

-- ----------------------------------------------------------------- builders

create policy products_select on public.products for select to anon, authenticated
  using (status = 'active' or paceline_private.is_team_member(owner_team_id));
create policy products_insert on public.products for insert to authenticated
  with check (paceline_private.is_team_admin(owner_team_id) and paceline_private.is_human() and status = 'pending'
              and (builder_agent_id is null
                   or exists (select 1 from public.agents a join public.team_members m on m.user_id = a.owner_user_id
                              where a.id = products.builder_agent_id and m.team_id = products.owner_team_id)));
create policy products_update on public.products for update to authenticated
  using (paceline_private.is_team_admin(owner_team_id) and paceline_private.is_human())
  with check (paceline_private.is_team_admin(owner_team_id)
              and (builder_agent_id is null
                   or exists (select 1 from public.agents a join public.team_members m on m.user_id = a.owner_user_id
                              where a.id = products.builder_agent_id and m.team_id = products.owner_team_id)));

create policy product_claims_select on public.product_claims for select to anon, authenticated
  using ((verified_at is not null and exists (select 1 from public.products p
                                               where p.id = product_claims.product_id and p.status = 'active'))
         or paceline_private.is_team_member(paceline_private.product_team(product_id)));
create policy product_claims_insert on public.product_claims for insert to authenticated
  with check (paceline_private.is_team_admin(paceline_private.product_team(product_id))
              and paceline_private.is_human() and verified_at is null);

create policy builder_tasks_select on public.builder_tasks for select to authenticated
  using (paceline_private.is_team_member(paceline_private.product_team(product_id)));

-- ---------------------------------------------------------------- messaging

-- Participants (by owner) see their threads; an agent recipient does not see
-- a thread still in 'request' (the stranger intro goes to the human only).
create policy threads_select on public.threads for select to authenticated
  using (paceline_private.is_thread_participant(id)
         and (state <> 'request' or created_by_user_id = (select auth.uid()) or paceline_private.is_human()));
create policy threads_insert on public.threads for insert to authenticated
  with check (created_by_user_id = (select auth.uid())
              and state = 'request'
              and (team_id is null or paceline_private.is_team_member(team_id))
              and ((created_by_agent_id is not null and paceline_private.agent_ok(created_by_agent_id))
                   or (created_by_agent_id is null and paceline_private.is_human())));
-- State changes are restricted further by the guard trigger in 0005.
create policy threads_update on public.threads for update to authenticated
  using (paceline_private.is_thread_participant(id))
  with check (paceline_private.is_thread_participant(id));

create policy thread_participants_select on public.thread_participants for select to authenticated
  using (paceline_private.is_thread_participant(thread_id));
-- The thread's creator adds participants (owner_user_id is derived by trigger).
create policy thread_participants_insert on public.thread_participants for insert to authenticated
  with check (paceline_private.thread_created_by_me(thread_id));
create policy thread_participants_update_self on public.thread_participants for update to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));
create policy thread_participants_delete_self on public.thread_participants for delete to authenticated
  using (owner_user_id = (select auth.uid()) and paceline_private.is_human());

-- Senders' owners see their own messages in every state (an agent: only the
-- ones it sent itself). Other participants
-- see delivered/released/expired ones; their HUMAN also sees quarantined and
-- request_pending ones (behind the UI's warning). Agents never do.
create policy messages_select on public.messages for select to authenticated
  using ((sender_owner_id = (select auth.uid())
          and (paceline_private.acting_agent_id() is null or sender_id = paceline_private.acting_agent_id()))
         or (paceline_private.is_thread_participant(thread_id)
             and (state in ('delivered', 'released', 'expired')
                  or (state in ('quarantined', 'request_pending') and paceline_private.is_human()))));
-- New messages always start 'queued' and unscreened; routing, screening and
-- delivery are worker transitions (I4, I8).
create policy messages_insert on public.messages for insert to authenticated
  with check (
    sender_owner_id = (select auth.uid())
    and state = 'queued'
    and screen_action is null and screen_label is null and verdict_id is null and delivered_at is null
    and paceline_private.is_thread_participant(thread_id)
    and ((sender_kind = 'agent' and paceline_private.agent_ok(sender_id) and trust is null)
         or (sender_kind = 'user' and sender_id = (select auth.uid()) and paceline_private.is_human()
             and (trust is null or trust = 'human_comment'))));
-- The sender's owner edits and resubmits a held_for_sender message.
create policy messages_resubmit on public.messages for update to authenticated
  using (sender_owner_id = (select auth.uid()) and state = 'held_for_sender' and paceline_private.is_human())
  with check (sender_owner_id = (select auth.uid()) and state = 'queued');

create policy message_deliveries_select on public.message_deliveries for select to authenticated
  using (paceline_private.agent_ok(recipient_agent_id) or paceline_private.message_sent_by_me(message_id));
-- Recipients mark seen/handled (monotonic: a handled delivery is final).
create policy message_deliveries_update on public.message_deliveries for update to authenticated
  using (paceline_private.agent_ok(recipient_agent_id) and state in ('pending', 'pointer_sent', 'seen'))
  with check (paceline_private.agent_ok(recipient_agent_id) and state in ('seen', 'handled'));

-- Readable by the owner and by the agent itself (never by another agent). An
-- instruction that needs the owner's confirm click (requires_confirm) stays
-- hidden from the agent until it is confirmed.
create policy owner_instructions_select on public.owner_instructions for select to authenticated
  using (paceline_private.agent_ok(agent_id)
         and (paceline_private.acting_agent_id() is null or not requires_confirm or confirmed_at is not null));
create policy owner_instructions_insert on public.owner_instructions for insert to authenticated
  with check (paceline_private.is_human()
              and created_by_user_id = (select auth.uid())
              and paceline_private.owns_agent(agent_id)
              and paceline_private.remote_instructions_on(agent_id)
              and verified_via = paceline_private.jwt_claim('via')
              and delivered_at is null and confirmed_at is null);
-- The agent marks its (visible) instruction delivered. Column changes are
-- further restricted by the guard trigger in 0005.
create policy owner_instructions_mark_delivered on public.owner_instructions for update to authenticated
  using (paceline_private.acting_agent_id() = agent_id and paceline_private.owns_agent(agent_id) and delivered_at is null
         and (not requires_confirm or confirmed_at is not null))
  with check (paceline_private.owns_agent(agent_id) and delivered_at is not null);
-- The owner's confirm click (web or Slack) for an unattended agent.
create policy owner_instructions_confirm on public.owner_instructions for update to authenticated
  using (paceline_private.is_human() and paceline_private.owns_agent(agent_id) and requires_confirm and confirmed_at is null)
  with check (paceline_private.owns_agent(agent_id) and confirmed_at is not null
              and confirmed_via = paceline_private.jwt_claim('via'));

-- I4: DM permissions are readable and writable by their owner only, and
-- writable only in human context (never by an agent or MCP tool).
create policy dm_permissions_select on public.dm_permissions for select to authenticated
  using (owner_user_id = (select auth.uid()));
create policy dm_permissions_insert on public.dm_permissions for insert to authenticated
  with check (owner_user_id = (select auth.uid()) and paceline_private.is_human());
create policy dm_permissions_update on public.dm_permissions for update to authenticated
  using (owner_user_id = (select auth.uid()) and paceline_private.is_human())
  with check (owner_user_id = (select auth.uid()));
create policy dm_permissions_delete on public.dm_permissions for delete to authenticated
  using (owner_user_id = (select auth.uid()) and paceline_private.is_human());

create policy work_claims_select on public.work_claims for select to authenticated
  using (paceline_private.is_thread_participant(thread_id));
create policy work_claims_insert on public.work_claims for insert to authenticated
  with check (paceline_private.agent_ok(agent_id) and paceline_private.is_thread_participant(thread_id));
create policy work_claims_update on public.work_claims for update to authenticated
  using (paceline_private.agent_ok(agent_id))
  with check (paceline_private.agent_ok(agent_id));
create policy work_claims_delete on public.work_claims for delete to authenticated
  using (paceline_private.owns_agent(agent_id));

-- ------------------------------------------------------- approvals and reports

-- Agents may LIST their owner's review items (review_queue) but only a human
-- decides them (I5, I11); see api.decide_review.
create policy review_items_select on public.review_items for select to authenticated
  using (owner_user_id = (select auth.uid()));
create policy review_items_decide on public.review_items for update to authenticated
  using (owner_user_id = (select auth.uid()) and state = 'pending' and paceline_private.is_human())
  with check (owner_user_id = (select auth.uid())
              and state in ('approved', 'rejected')
              and decided_by = (select auth.uid())
              and decision_id is not null
              and decided_via = paceline_private.jwt_claim('via'));

create policy reports_select on public.reports for select to authenticated
  using (reporter_user_id = (select auth.uid()));
create policy reports_insert on public.reports for insert to authenticated
  with check (reporter_user_id = (select auth.uid()) and review_item_id is null and resolved_at is null);

-- -------------------------------------------------------------------- scroll

create policy setup_suggestions_select on public.setup_suggestions for select to authenticated
  using (status = 'ready'
         and (scope = 'public-aggregate' or paceline_private.is_team_member(team_id)));

create policy change_requests_select on public.change_requests for select to authenticated
  using (owner_user_id = (select auth.uid()) and paceline_private.agent_ok(agent_id));
-- propose_setup_change: unsigned and unapproved by construction (I1, I5),
-- and only from a ready suggestion the caller can see. Core renders the
-- patch server-side from that suggestion; agents never supply patch content.
create policy change_requests_insert on public.change_requests for insert to authenticated
  with check (owner_user_id = (select auth.uid())
              and paceline_private.agent_ok(agent_id)
              and suggestion_id is not null
              and exists (select 1 from public.setup_suggestions g where g.id = change_requests.suggestion_id)
              and state = 'pending_approval'
              and signature is null and kid is null and approved_by is null and approved_at is null
              and applied_at is null and post_hashes is null);
-- The applier reports results for approved changes only.
create policy change_requests_report on public.change_requests for update to authenticated
  using (owner_user_id = (select auth.uid()) and paceline_private.agent_ok(agent_id)
         and state in ('approved', 'applied'))
  with check (owner_user_id = (select auth.uid()) and state in ('applied', 'failed', 'rolled_back'));

create policy adoptions_select on public.adoptions for select to authenticated
  using (exists (select 1 from public.change_requests c where c.id = adoptions.change_request_id));

-- ------------------------------------------------------------- infra, slack

create policy notification_prefs_select on public.notification_prefs for select to authenticated
  using (user_id = (select auth.uid()));
create policy notification_prefs_insert on public.notification_prefs for insert to authenticated
  with check (user_id = (select auth.uid()) and paceline_private.is_human());
create policy notification_prefs_update on public.notification_prefs for update to authenticated
  using (user_id = (select auth.uid()) and paceline_private.is_human())
  with check (user_id = (select auth.uid()));

create policy slack_identity_links_select on public.slack_identity_links for select to authenticated
  using (user_id = (select auth.uid()));

-- -------------------------------------------------------------- prompt feedback

-- Private to the human by default (PLAN §8).
create policy prompt_feedback_select on public.prompt_feedback for select to authenticated
  using (user_id = (select auth.uid()));
create policy prompt_feedback_update on public.prompt_feedback for update to authenticated
  using (user_id = (select auth.uid()) and paceline_private.is_human())
  with check (user_id = (select auth.uid()));

-- =========================================================================== grants

revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all routines in schema public from public, anon, authenticated;
grant all on all tables in schema public to service_role;
grant usage, select, update on all sequences in schema public to service_role;

-- Signed-out (anon) public read paths: public content and its authors,
-- setup cards, leaderboards, products, kill switches.
grant select on public.users, public.agents, public.activities, public.highlights, public.highlight_errors,
  public.setup_versions, public.setup_components, public.shared_components, public.setup_reviews,
  public.segments, public.segment_stats, public.products, public.product_claims, public.kill_switches
  to anon;

-- authenticated: SELECT where policies allow ...
grant select on
  public.users, public.user_private, public.teams, public.team_secrets, public.team_members, public.team_policies,
  public.team_invites, public.agents, public.agent_settings, public.agent_presence, public.realtime_channels,
  public.follows, public.friendships, public.oauth_grants, public.orgs, public.org_members, public.org_teams,
  public.repo_access, public.kill_switches, public.segments, public.sessions, public.session_leases,
  public.setup_versions, public.shared_components, public.setup_components, public.activities,
  public.activity_chunks, public.highlights, public.highlight_errors, public.daily_rollups, public.setup_reviews,
  public.segment_efforts, public.segment_stats, public.personal_records, public.kudos, public.outcome_events,
  public.content_exposures, public.products, public.product_claims, public.builder_tasks,
  public.thread_participants, public.messages, public.message_deliveries, public.owner_instructions,
  public.dm_permissions, public.work_claims, public.review_items, public.reports, public.setup_suggestions,
  public.change_requests, public.adoptions, public.notification_prefs, public.slack_identity_links,
  public.prompt_feedback
  to authenticated;
-- threads: everything except the unscreened requested_subject.
grant select (id, kind, anchor_kind, anchor_id, product_id, repo_key, team_id, subject, state, created_by_user_id,
              created_by_agent_id, assigned_agent_id, last_message_at, created_at, updated_at)
  on public.threads to authenticated;
-- installs: everything except the token hash.
grant select (id, agent_id, scopes, plugin_version, harness_version, platform, machine_label, machine_label_hash,
              created_at, last_seen_at, revoked_at)
  on public.installs to authenticated;

-- ... INSERT where policies allow ...
grant insert on
  public.team_members, public.team_policies, public.follows, public.friendships, public.oauth_grants,
  public.org_members, public.org_teams, public.sessions, public.session_leases, public.setup_versions,
  public.activity_chunks, public.kudos, public.outcome_events, public.content_exposures,
  public.thread_participants, public.dm_permissions, public.reports, public.notification_prefs
  to authenticated;
grant insert (id, thread_id, repo_key, agent_id, area_glob, until) on public.work_claims to authenticated;
-- shared_component_id is linked by the worker (by content hash), never by the caller.
grant insert (setup_version_id, kind, name, version, content_hash, description_redacted)
  on public.setup_components to authenticated;
grant insert (slug, name, created_by) on public.teams to authenticated;
grant insert (team_id, token_hash, role, created_by, expires_at, max_uses) on public.team_invites to authenticated;
grant insert (id, owner_user_id, handle, harness, variant) on public.agents to authenticated;
grant insert (id, agent_id, token_hash, scopes, plugin_version, harness_version, platform, machine_label,
              machine_label_hash)
  on public.installs to authenticated;
grant insert (slug, name, created_by) on public.orgs to authenticated;
grant insert (id, agent_id, owner_user_id, session_id, kind, setup_version_id, team_id, source, visibility, status,
              repo_key, title, summary, task_intent, stack_tags, size_bucket, stats, laps, outcome, outcome_status,
              tokens_total, turns, tool_calls, failed_tool_calls, wall_ms, active_ms, cost_usd, started_at, ended_at)
  on public.activities to authenticated;
grant insert (id, author_agent_id, owner_user_id, team_id, kind, name, version, content, content_hash, visibility, status)
  on public.shared_components to authenticated;
grant insert (id, component_id, reviewer_agent_id, owner_user_id, used_for, worked_when, failed_when, status)
  on public.setup_reviews to authenticated;
grant insert (id, slug, name, owner_team_id, builder_agent_id, sla_minutes, reply_policy, status)
  on public.products to authenticated;
grant insert (product_id, kind, value) on public.product_claims to authenticated;
grant insert (id, kind, anchor_kind, anchor_id, product_id, repo_key, team_id, requested_subject, state,
              created_by_user_id, created_by_agent_id)
  on public.threads to authenticated;
grant insert (id, thread_id, sender_kind, sender_id, sender_owner_id, trust, intent, urgency, body, refs, state,
              idempotency_key)
  on public.messages to authenticated;
grant insert (id, agent_id, thread_id, created_by_user_id, body, verified_via, kid, sig, requires_confirm)
  on public.owner_instructions to authenticated;
grant insert (id, agent_id, owner_user_id, suggestion_id, target, repo_key, patch, patch_hash, base_hashes, state,
              expires_at)
  on public.change_requests to authenticated;

-- ... UPDATE on specific columns only ...
grant update (display_name, public_profile) on public.users to authenticated;
grant update (name) on public.teams to authenticated;
grant update (role, policy_accepted_version) on public.team_members to authenticated;
grant update (revoked_at) on public.team_invites to authenticated;
grant update (status) on public.agents to authenticated;
grant update (remote_instructions, wake_on_dm, quiet_hours) on public.agent_settings to authenticated;
grant update (presence, listener) on public.agent_presence to authenticated;
grant update (revoked_at, last_seen_at, plugin_version, harness_version, platform) on public.installs to authenticated;
grant update (state) on public.friendships to authenticated;
grant update (permissions, revoked_at) on public.oauth_grants to authenticated;
grant update (name) on public.orgs to authenticated;
grant update (role, share_aggregates, share_individual, show_on_leaderboard) on public.org_members to authenticated;
grant update (last_event_at, ended_at, close_reason, status, harness_version, repo_key) on public.sessions to authenticated;
grant update (install_id, repo_key, listening, last_heartbeat_at, last_thread_ids, permission_mode, headless)
  on public.session_leases to authenticated;
grant update (visibility, status) on public.activities to authenticated;
grant update (visibility, status) on public.highlights to authenticated;
grant update (visibility, status) on public.shared_components to authenticated;
grant update (name, sla_minutes, reply_policy, builder_agent_id) on public.products to authenticated;
grant update (state, assigned_agent_id) on public.threads to authenticated;
grant update (last_read_message_id, muted) on public.thread_participants to authenticated;
grant update (body, refs, state) on public.messages to authenticated;
grant update (state, seen_at, handled_at) on public.message_deliveries to authenticated;
grant update (delivered_at, confirmed_at, confirmed_via) on public.owner_instructions to authenticated;
grant update (policy, delivery) on public.dm_permissions to authenticated;
grant update (until) on public.work_claims to authenticated;
grant update (state, decision, decision_id, decided_by, decided_via, decided_at) on public.review_items to authenticated;
grant update (state, applied_at, post_hashes, pr_url) on public.change_requests to authenticated;
grant update (channels, batching, kinds) on public.notification_prefs to authenticated;
grant update (dismissed_at, helpful) on public.prompt_feedback to authenticated;

-- ... DELETE where policies allow.
grant delete on public.team_members, public.session_leases, public.follows, public.friendships, public.oauth_grants,
  public.org_members, public.org_teams, public.kudos, public.thread_participants, public.dm_permissions,
  public.work_claims
  to authenticated;

-- Helper functions: revoke the default PUBLIC execute, then grant what RLS
-- evaluation needs. Every helper answers questions about the caller only.
revoke all on all functions in schema paceline_private from public, anon, authenticated, service_role;
grant execute on function
  paceline_private.ulid(), paceline_private.random_hex64(),
  paceline_private.immutable_array_to_string(text[], text), paceline_private.jsonb_strings(jsonb),
  paceline_private.text_array_ok(text[], text, int), paceline_private.event_payload_ok(jsonb),
  paceline_private.jwt_claim(text), paceline_private.acting_agent_id(), paceline_private.is_agent_context(),
  paceline_private.is_human(), paceline_private.is_service(),
  paceline_private.is_team_member(uuid), paceline_private.is_team_admin(uuid), paceline_private.is_team_owner(uuid),
  paceline_private.is_org_member(uuid), paceline_private.is_org_admin(uuid), paceline_private.can_see_repo(text),
  paceline_private.owns_agent(uuid), paceline_private.agent_ok(uuid), paceline_private.is_thread_participant(text),
  paceline_private.thread_created_by_me(text), paceline_private.message_sent_by_me(text),
  paceline_private.remote_instructions_on(uuid), paceline_private.product_team(text),
  paceline_private.user_is_public(uuid), paceline_private.shares_team_with(uuid),
  paceline_private.user_is_visible(uuid), paceline_private.is_agent_participant(text, uuid),
  paceline_private.can_notify_user(uuid),
  paceline_private.visible_content(uuid, uuid, text, text),
  paceline_private.visible_activity(public.activities), paceline_private.visible_highlight(public.highlights)
  to anon, authenticated, service_role;

-- ================================================================ RLS safety net

do $guard$
declare
  missing text;
begin
  select string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by n.nspname, c.relname)
    into missing
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and n.nspname in ('public', 'paceline_private')
    and not c.relrowsecurity;
  if missing is not null then
    raise exception 'row level security is not enabled on: %', missing;
  end if;
end
$guard$;
