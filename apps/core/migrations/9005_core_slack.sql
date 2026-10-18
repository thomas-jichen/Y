-- apps/core local migration (owner: core slack). Slack v1 (PLAN §11).
--
-- New tables are service-only (RLS on, no policies, no grants to anon or
-- authenticated); the web reaches them only through the definer function
-- api.unlink_slack(). No existing policy is loosened (I7). Idempotent.

-- 1. thread_bridges: one bridge per (Y thread, workspace, Slack channel). Each
--    linked user gets notices in their own bot DM channel, so the 0002 primary
--    key (thread_id, slack_team_id) is too narrow. The unique
--    (slack_team_id, channel_id, thread_ts) from 0002 stays: reply lookup.
alter table public.thread_bridges add column if not exists for_user_id uuid references public.users (id) on delete cascade;
alter table public.thread_bridges drop constraint if exists thread_bridges_pkey;
alter table public.thread_bridges add constraint thread_bridges_pkey primary key (thread_id, slack_team_id, channel_id);

-- 2. Team feed channel (one per team).
create table if not exists public.team_slack_channels (
  team_id uuid primary key references public.teams (id) on delete cascade,
  slack_team_id text not null check (slack_team_id ~ '^[A-Z0-9]{5,20}$'),
  channel_id text not null check (channel_id ~ '^[CG][A-Z0-9]{4,19}$'),
  set_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.team_slack_channels enable row level security;
revoke all on public.team_slack_channels from public, anon, authenticated;
grant all on public.team_slack_channels to service_role;

-- 3. Slack replies waiting for the owner's Confirm click before they become an
--    owner instruction (I5). The body is dropped once decided.
create table if not exists public.slack_pending_instructions (
  id y_private.ulid primary key default y_private.ulid(),
  user_id uuid not null references public.users (id) on delete cascade,
  thread_id y_private.ulid not null references public.threads (id) on delete cascade,
  slack_team_id text not null check (slack_team_id ~ '^[A-Z0-9]{5,20}$'),
  slack_user_id text not null check (slack_user_id ~ '^[A-Z0-9]{5,20}$'),
  channel_id text not null check (channel_id ~ '^[CDG][A-Z0-9]{4,19}$'),
  thread_ts text not null check (thread_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  source_event_id text not null unique check (char_length(source_event_id) between 1 and 128),
  body text check (char_length(body) between 1 and 4000),
  state text not null default 'pending' check (state in ('pending', 'confirmed', 'cancelled', 'expired')),
  owner_instruction_id y_private.ulid references public.owner_instructions (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  decided_at timestamptz,
  check ((state = 'pending') = (body is not null))
);
create index if not exists slack_pending_instructions_created_idx on public.slack_pending_instructions (created_at);
alter table public.slack_pending_instructions enable row level security;
revoke all on public.slack_pending_instructions from public, anon, authenticated;
grant all on public.slack_pending_instructions to service_role;

-- 4. Where each review item was posted, so the message can be updated when it
--    is decided anywhere (Slack, web, expiry).
create table if not exists public.slack_review_posts (
  review_id y_private.ulid not null references public.review_items (id) on delete cascade,
  slack_team_id text not null check (slack_team_id ~ '^[A-Z0-9]{5,20}$'),
  channel_id text not null check (channel_id ~ '^[CDG][A-Z0-9]{4,19}$'),
  ts text not null check (ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  created_at timestamptz not null default now(),
  primary key (review_id, channel_id)
);
alter table public.slack_review_posts enable row level security;
revoke all on public.slack_review_posts from public, anon, authenticated;
grant all on public.slack_review_posts to service_role;

-- 5. True when the user has an active Slack link and Slack notifications on.
create or replace function y_private.slack_notify_on(p_user uuid) returns boolean
language sql stable security definer set search_path = ''
as $fn$
  select exists (
    select 1 from public.slack_identity_links l
      join public.notification_prefs p on p.user_id = l.user_id
     where l.user_id = p_user and l.revoked_at is null and p.channels -> 'slack' = 'true'::jsonb)
$fn$;
revoke all on function y_private.slack_notify_on(uuid) from public, anon, authenticated;
grant execute on function y_private.slack_notify_on(uuid) to service_role;

-- 6. Every new pending review item (any kind, any code path) queues one Slack
--    notice for a linked owner, in the inserting transaction. A decision
--    queues a message update when the item was posted to Slack.
create or replace function y_private.slack_on_review_item()
returns trigger language plpgsql volatile security definer set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    if new.state = 'pending' and y_private.slack_notify_on(new.owner_user_id) then
      insert into public.jobs (topic, payload, dedupe_key, max_attempts)
      values ('slack.notify_review', jsonb_build_object('reviewId', new.id), 'slack:rv:' || new.id, 5)
      on conflict (dedupe_key) do nothing;
    end if;
  elsif exists (select 1 from public.slack_review_posts s where s.review_id = new.id) then
    insert into public.jobs (topic, payload, dedupe_key, max_attempts)
    values ('slack.review_decided', jsonb_build_object('reviewId', new.id), 'slack:rvd:' || new.id, 5)
    on conflict (dedupe_key) do nothing;
  end if;
  return null;
end
$fn$;
revoke all on function y_private.slack_on_review_item() from public, anon, authenticated, service_role;
drop trigger if exists review_items_slack_new on public.review_items;
create trigger review_items_slack_new after insert on public.review_items
  for each row execute function y_private.slack_on_review_item();
drop trigger if exists review_items_slack_decided on public.review_items;
create trigger review_items_slack_decided after update of state on public.review_items
  for each row when (old.state = 'pending' and new.state <> 'pending')
  execute function y_private.slack_on_review_item();

-- 7. Web unlink (slack_identity_links has no update policy for authenticated).
create or replace function api.unlink_slack() returns boolean
language plpgsql volatile security definer set search_path = ''
as $fn$
declare v_n int;
begin
  if not y_private.is_human() then
    raise exception using errcode = '42501', message = 'unlink_slack: requires a human session';
  end if;
  update public.slack_identity_links set revoked_at = now()
   where user_id = auth.uid() and revoked_at is null;
  get diagnostics v_n = row_count;
  update public.notification_prefs set channels = channels || '{"slack": false}'::jsonb, updated_at = now()
   where user_id = auth.uid();
  return v_n > 0;
end
$fn$;
revoke all on function api.unlink_slack() from public, anon;
grant execute on function api.unlink_slack() to authenticated, service_role;

-- 8. The Slack username at /y connect time, shown on the web link preview so
--    the person linking sees whose Slack account the token binds (display
--    only; identity is slack_user_id). The table stays service-only.
alter table public.slack_link_tokens add column if not exists slack_user_name text
  check (slack_user_name is null or slack_user_name ~ '^[A-Za-z0-9._-]{1,80}$');
