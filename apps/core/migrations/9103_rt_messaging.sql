-- apps/core local migration (owner: core messaging). Red-team fixes.
--
-- Two service-only bookkeeping tables (RLS on, no policies, no grants to anon
-- or authenticated): core reaches them as the service role only, and two
-- triggers (security definer) keep them. No existing policy or trigger is
-- loosened or replaced and no existing table changes shape (I7). Idempotent.

-- 1. Who paused a thread (POST /api/v1/threads/:id/pause). Only that human, or
--    a teammate of theirs, may undo the pause (reopen, or resolve a paused
--    thread): a counterparty's owner cannot lift a pause put on their agent.
create table if not exists y_private.thread_pauses (
  thread_id y_private.ulid primary key references public.threads (id) on delete cascade,
  paused_by uuid not null references public.users (id) on delete cascade,
  paused_at timestamptz not null default now()
);
alter table y_private.thread_pauses enable row level security;
revoke all on y_private.thread_pauses from public;
grant all on y_private.thread_pauses to service_role;

-- 2. Idempotency keys for web owner instructions (POST /api/v1/threads/:id/instruct
--    with an Idempotency-Key header): a double submit or a client retry returns
--    the instruction already issued instead of signing a second one.
create table if not exists y_private.owner_instruction_keys (
  user_id uuid not null references public.users (id) on delete cascade,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  owner_instruction_id y_private.ulid not null references public.owner_instructions (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);
alter table y_private.owner_instruction_keys enable row level security;
revoke all on y_private.owner_instruction_keys from public;
grant all on y_private.owner_instruction_keys to service_role;

-- 3. The pause rule, enforced in the database in the same statement as the
--    state change (the REST route is not the only writer: threads_update lets
--    any participant's owner update the row directly). A separate AFTER trigger
--    so guard_thread_state is left exactly as it is.
--    * A human moving a thread to paused_by_owner is recorded as its pauser.
--    * A human moving it from paused_by_owner to open or resolved must be that
--      pauser or a teammate of theirs (else 42501). Archiving is unchanged (it
--      lets no agent write again). Leaving the pause clears the record.
--    The service role (worker) and direct superuser maintenance are unchanged.
create or replace function y_private.rt_thread_pause_owner()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
  v_user boolean := coalesce(auth.role(), '') in ('authenticated', 'anon');
  v_pauser uuid;
begin
  if new.state = old.state then
    return null;
  end if;
  if old.state = 'paused_by_owner' then
    select p.paused_by into v_pauser from y_private.thread_pauses p where p.thread_id = new.id;
    if v_user and new.state in ('open', 'resolved') and v_pauser is not null and v_pauser is distinct from v_uid
       and not exists (select 1 from public.team_members a join public.team_members b on a.team_id = b.team_id
                        where a.user_id = v_pauser and b.user_id = v_uid) then
      raise exception using errcode = '42501',
        message = 'threads: only the owner who paused this thread (or a teammate of theirs) can lift the pause';
    end if;
    delete from y_private.thread_pauses p where p.thread_id = new.id;
  end if;
  if new.state = 'paused_by_owner' and v_user and v_uid is not null then
    insert into y_private.thread_pauses (thread_id, paused_by) values (new.id, v_uid)
    on conflict (thread_id) do update set paused_by = excluded.paused_by, paused_at = now();
  end if;
  return null;
end
$fn$;
revoke all on function y_private.rt_thread_pause_owner() from public, anon, authenticated, service_role;

drop trigger if exists threads_rt_pause_owner on public.threads;
create trigger threads_rt_pause_owner
  after update of state on public.threads
  for each row execute function y_private.rt_thread_pause_owner();

-- 4. A member who leaves a team stops being a room recipient (9004); their
--    agents' room deliveries that were never read expire, so unread counts and
--    pointers (pulse, status, the hook pulse) stop pointing at messages the
--    agent can no longer read. Only on leave: a paused agent keeps its backlog.
create or replace function y_private.rt_room_leave_expire_deliveries()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  update public.message_deliveries d set state = 'expired', updated_at = now()
    from public.messages m, y_private.team_rooms r
   where m.id = d.message_id and r.team_id = old.team_id and m.thread_id = r.thread_id
     and d.state in ('pending', 'pointer_sent')
     and d.recipient_agent_id in (select a.id from public.agents a where a.owner_user_id = old.user_id);
  return null;
end
$fn$;
revoke all on function y_private.rt_room_leave_expire_deliveries() from public, anon, authenticated, service_role;

drop trigger if exists team_members_rt_room_leave_deliveries on public.team_members;
create trigger team_members_rt_room_leave_deliveries
  after delete on public.team_members
  for each row execute function y_private.rt_room_leave_expire_deliveries();
