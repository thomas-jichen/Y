-- apps/core local migration (owner: core). Production auth helpers.
--
-- 1. api.resolve_web_session also returns created_at, so step-up (I5) can
--    reject dev/demo sessions older than 12 h.
-- 2. y_private.provision_user(id, user_metadata, app_metadata):
--    ensures public.users exists for a verified Supabase access token. On
--    Supabase the auth.users trigger normally did this already; the function
--    covers users created before the migrations ran (and local tests, where
--    auth.users is the shim). Service role only.
-- 3. api.install_state(install_id): revoked/active check for pulse tokens.

drop function if exists api.resolve_web_session(text);
create function api.resolve_web_session(p_token_hash text)
returns table (user_id uuid, user_status text, created_at timestamptz)
language sql stable security definer
set search_path = ''
as $fn$
  select s.user_id, u.status, s.created_at
  from y_private.web_sessions s
  join public.users u on u.id = s.user_id
  where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > now()
$fn$;
revoke all on function api.resolve_web_session(text) from public;
grant execute on function api.resolve_web_session(text) to anon, authenticated, service_role;

create or replace function y_private.provision_user(p_id uuid, p_meta jsonb, p_app jsonb)
returns boolean
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_meta jsonb := coalesce(p_meta, '{}'::jsonb);
  v_app jsonb := coalesce(p_app, '{}'::jsonb);
  v_login text := nullif(coalesce(v_meta ->> 'user_name', v_meta ->> 'preferred_username'), '');
  v_base text;
  v_handle text;
  v_attempt int := 0;
begin
  if exists (select 1 from public.users u where u.id = p_id) then
    return false;
  end if;
  if not exists (select 1 from auth.users a where a.id = p_id) then
    -- The handle_new_auth_user trigger creates public.users (handle from user_name).
    insert into auth.users (id, raw_user_meta_data, raw_app_meta_data)
    values (p_id, v_meta, v_app)
    on conflict (id) do nothing;
    return exists (select 1 from public.users u where u.id = p_id);
  end if;
  -- auth.users exists but the trigger never ran: same handle rules, no github_id.
  if v_login is not null and v_login !~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$' then
    v_login := null;
  end if;
  v_base := btrim(regexp_replace(lower(coalesce(v_login, '')), '[^a-z0-9-]+', '-', 'g'), '-');
  if char_length(v_base) < 3 then
    v_base := 'user-' || substr(replace(p_id::text, '-', ''), 1, 8);
  end if;
  v_base := left(v_base, 28);
  loop
    v_attempt := v_attempt + 1;
    v_handle := case
      when v_attempt = 1 then v_base
      when v_attempt <= 50 then left(v_base, 28) || '-' || v_attempt::text
      else 'user-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
    end;
    continue when exists (select 1 from public.handle_registry r where r.handle = v_handle);
    begin
      insert into public.users (id, github_login, handle, display_name, avatar_url)
      values (
        p_id,
        v_login,
        v_handle,
        nullif(left(coalesce(v_meta ->> 'full_name', v_meta ->> 'name', ''), 80), ''),
        nullif(left(coalesce(v_meta ->> 'avatar_url', ''), 2048), '')
      )
      on conflict (id) do nothing;
      return true;
    exception when unique_violation then
      if v_attempt > 60 then
        raise;
      end if;
    end;
  end loop;
end
$fn$;
revoke all on function y_private.provision_user(uuid, jsonb, jsonb) from public;
grant execute on function y_private.provision_user(uuid, jsonb, jsonb) to service_role;

create or replace function api.install_state(p_install_id uuid)
returns table (revoked boolean, agent_status text, user_status text)
language sql stable security definer
set search_path = ''
as $fn$
  select i.revoked_at is not null, a.status, u.status
  from public.installs i
  join public.agents a on a.id = i.agent_id
  join public.users u on u.id = a.owner_user_id
  where i.id = p_install_id
$fn$;
revoke all on function api.install_state(uuid) from public;
grant execute on function api.install_state(uuid) to authenticated, service_role;

-- Realtime REST fan-out cursor (serverless core without realtime.send in the DB):
-- one row; each instance claims (last_id, max(events.id)] atomically so every
-- event is broadcast at most once across instances.
create table if not exists y_private.realtime_cursor (
  id boolean primary key default true check (id),
  last_id bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table y_private.realtime_cursor enable row level security;
grant all on y_private.realtime_cursor to service_role;
insert into y_private.realtime_cursor (id, last_id)
  values (true, coalesce((select max(id) from public.events), 0))
  on conflict (id) do nothing;
