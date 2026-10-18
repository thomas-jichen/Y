-- apps/core local migration (owner: core platform). Red-team fixes, auth cluster.
--
-- 1. Provisioning trusts profile metadata (user_name, full_name, avatar_url)
--    only from providers whose metadata Y or GitHub controls: 'github', 'dev'
--    (dev login) and 'system' (the seed loader). Email or other sign-ups get a
--    generated handle and no github_login, so they cannot claim a GitHub
--    identity (#10). The system handles 'y-team' and 'yhq' are reserved for the
--    'system' provider (#86).
-- 2. y_private.provision_user never creates auth.users on real Supabase Auth
--    (detected by auth.identities): a token whose auth user is gone cannot
--    resurrect it, and github_id is never taken from JWT user_metadata (#69).
-- 3. Demo-account web sessions record the demo login they were minted for, so
--    core can reject them once Y_DEMO_ACCOUNT is unset or changed (#44).
-- 4. api.pulse_install(install_id): owner, agent and state of an install, so a
--    pulse token is bound to a live install of that agent (#3, #31).
-- 5. y_private.is_dev_user / y_private.dev_team_open: dev login only reuses
--    dev users and only joins teams made of dev users (#4, #42).

-- ------------------------------------------------------------------ helpers

create or replace function y_private.trusted_profile_provider(p_app jsonb)
returns boolean
language sql immutable
set search_path = ''
as $fn$
  select coalesce(p_app ->> 'provider', '') in ('github', 'dev', 'system')
      or coalesce(p_app -> 'providers' ? 'github', false)
$fn$;
revoke all on function y_private.trusted_profile_provider(jsonb) from public;

create or replace function y_private.reserved_handle(p_handle text, p_app jsonb)
returns boolean
language sql immutable
set search_path = ''
as $fn$
  select p_handle in ('y-team', 'yhq') and coalesce(p_app ->> 'provider', '') <> 'system'
$fn$;
revoke all on function y_private.reserved_handle(text, jsonb) from public;

-- --------------------------------------------------- 1. auth.users trigger

create or replace function y_private.handle_new_auth_user()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_app jsonb := coalesce(new.raw_app_meta_data, '{}'::jsonb);
  v_trusted boolean := y_private.trusted_profile_provider(coalesce(new.raw_app_meta_data, '{}'::jsonb));
  v_login text;
  v_github_id bigint;
  v_base text;
  v_handle text;
  v_attempt int := 0;
begin
  v_login := case when v_trusted then nullif(coalesce(v_meta ->> 'user_name', v_meta ->> 'preferred_username'), '') end;
  if v_login is not null and v_login !~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$' then
    v_login := null;
  end if;
  if (v_app ->> 'provider' = 'github' or v_app -> 'providers' ? 'github')
     and (v_meta ->> 'provider_id') ~ '^[0-9]{1,18}$' then
    v_github_id := (v_meta ->> 'provider_id')::bigint;
    if exists (select 1 from public.users u where u.github_id = v_github_id) then
      v_github_id := null;
    end if;
  end if;

  v_base := btrim(regexp_replace(lower(coalesce(v_login, '')), '[^a-z0-9-]+', '-', 'g'), '-');
  if char_length(v_base) < 3 then
    v_base := 'user-' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;
  v_base := left(v_base, 28);

  loop
    v_attempt := v_attempt + 1;
    v_handle := case
      when v_attempt = 1 then v_base
      when v_attempt <= 50 then left(v_base, 28) || '-' || v_attempt::text
      else 'user-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
    end;
    continue when y_private.reserved_handle(v_handle, v_app);
    continue when exists (select 1 from public.handle_registry r where r.handle = v_handle);
    begin
      insert into public.users (id, github_id, github_login, handle, display_name, avatar_url)
      values (
        new.id,
        v_github_id,
        v_login,
        v_handle,
        case when v_trusted then nullif(left(coalesce(v_meta ->> 'full_name', v_meta ->> 'name', ''), 80), '') end,
        case when v_trusted then nullif(left(coalesce(v_meta ->> 'avatar_url', ''), 2048), '') end
      )
      on conflict (id) do nothing;
      return new;
    exception when unique_violation then
      -- Lost a race for the handle; try the next candidate.
      if v_attempt > 60 then
        raise;
      end if;
    end;
  end loop;
end
$fn$;

-- ------------------------------------------------- 2. provision_user (JWT)

create or replace function y_private.provision_user(p_id uuid, p_meta jsonb, p_app jsonb)
returns boolean
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_meta jsonb := coalesce(p_meta, '{}'::jsonb);
  v_app jsonb := coalesce(p_app, '{}'::jsonb);
  v_db_app jsonb;
  v_trusted boolean;
  v_login text;
  v_base text;
  v_handle text;
  v_attempt int := 0;
begin
  if exists (select 1 from public.users u where u.id = p_id) then
    return false;
  end if;
  select a.raw_app_meta_data into v_db_app from auth.users a where a.id = p_id;
  if not found then
    -- Real Supabase Auth always has the auth.users row of a live user: a token
    -- whose user is gone must not bring it back.
    if to_regclass('auth.identities') is not null then
      return false;
    end if;
    -- Local shim / tests: create it. The handle_new_auth_user trigger creates
    -- public.users. provider_id is user-editable in JWT user_metadata, so it
    -- never becomes a github_id here.
    insert into auth.users (id, raw_user_meta_data, raw_app_meta_data)
    values (p_id, v_meta - 'provider_id', v_app)
    on conflict (id) do nothing;
    return exists (select 1 from public.users u where u.id = p_id);
  end if;
  -- auth.users exists but the trigger never ran: same handle rules, no github_id.
  v_app := coalesce(v_db_app, v_app);
  v_trusted := y_private.trusted_profile_provider(v_app);
  v_login := case when v_trusted then nullif(coalesce(v_meta ->> 'user_name', v_meta ->> 'preferred_username'), '') end;
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
    continue when y_private.reserved_handle(v_handle, v_app);
    continue when exists (select 1 from public.handle_registry r where r.handle = v_handle);
    begin
      insert into public.users (id, github_login, handle, display_name, avatar_url)
      values (
        p_id,
        v_login,
        v_handle,
        case when v_trusted then nullif(left(coalesce(v_meta ->> 'full_name', v_meta ->> 'name', ''), 80), '') end,
        case when v_trusted then nullif(left(coalesce(v_meta ->> 'avatar_url', ''), 2048), '') end
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

-- ------------------------------------------------ 3. demo-account sessions

alter table y_private.web_sessions add column if not exists demo_account text;

drop function if exists api.resolve_web_session(text);
create function api.resolve_web_session(p_token_hash text)
returns table (user_id uuid, user_status text, created_at timestamptz, demo_account text)
language sql stable security definer
set search_path = ''
as $fn$
  select s.user_id, u.status, s.created_at, s.demo_account
  from y_private.web_sessions s
  join public.users u on u.id = s.user_id
  where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > now()
$fn$;
revoke all on function api.resolve_web_session(text) from public;
grant execute on function api.resolve_web_session(text) to anon, authenticated, service_role;

-- ------------------------------------------------------- 4. pulse binding

create or replace function api.pulse_install(p_install_id uuid)
returns table (agent_id uuid, owner_user_id uuid, revoked boolean, agent_status text, user_status text)
language sql stable security definer
set search_path = ''
as $fn$
  select i.agent_id, a.owner_user_id, i.revoked_at is not null, a.status, u.status
  from public.installs i
  join public.agents a on a.id = i.agent_id
  join public.users u on u.id = a.owner_user_id
  where i.id = p_install_id
$fn$;
revoke all on function api.pulse_install(uuid) from public;
grant execute on function api.pulse_install(uuid) to service_role;

-- ---------------------------------------------------- 5. dev-login guards

-- A user that dev login created (auth provider 'dev'), never a real account.
create or replace function y_private.is_dev_user(p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from auth.users a
    where a.id = p_user_id and a.raw_app_meta_data ->> 'provider' = 'dev'
  )
$fn$;
revoke all on function y_private.is_dev_user(uuid) from public;
grant execute on function y_private.is_dev_user(uuid) to service_role;

-- May dev routes add members to this team? Only when neither its creator nor
-- any member is a real account, apart from p_except (the caller, already in it).
create or replace function y_private.dev_team_open(p_team_id uuid, p_except uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select not exists (
    select 1 from public.team_members m
    where m.team_id = p_team_id
      and m.user_id is distinct from p_except
      and not y_private.is_dev_user(m.user_id)
  ) and not exists (
    select 1 from public.teams t
    where t.id = p_team_id
      and t.created_by is not null
      and t.created_by is distinct from p_except
      and not y_private.is_dev_user(t.created_by)
  )
$fn$;
revoke all on function y_private.dev_team_open(uuid, uuid) from public;
grant execute on function y_private.dev_team_open(uuid, uuid) to service_role;
