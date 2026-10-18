-- apps/core local migration (owner: core builders). Red-team fixes for builders.
--
-- A product's builder agent must be owned by a member of the product's team
-- (products_insert / products_update RLS). That was only checked when
-- builder_agent_id was written: after the owner left or was removed from the
-- team, their agent kept receiving the product's customer questions and its
-- drafts kept going out as the team's product. Now leaving the team unsets
-- that builder (the product takes no messages until an admin picks a new
-- one, as with an unset builder) and the agent leaves the product's support
-- threads, as syncSupportBuilders does for a replaced builder (I4).
-- Idempotent.

create or replace function y_private.unset_departed_builders() returns trigger
language plpgsql security definer
set search_path = ''
as $fn$
declare
  v_ids text[];
begin
  with gone as (
    update public.products p set builder_agent_id = null, updated_at = now()
      from public.agents a
     where p.owner_team_id = old.team_id and a.id = p.builder_agent_id and a.owner_user_id = old.user_id
    returning p.id::text as id
  )
  select coalesce(array_agg(id), '{}') into v_ids from gone;
  if array_length(v_ids, 1) is not null then
    delete from public.thread_participants tp using public.threads t
     where tp.thread_id = t.id and t.kind = 'support' and t.product_id::text = any(v_ids)
       and tp.p_kind = 'agent' and tp.role = 'builder';
  end if;
  return old;
end
$fn$;
revoke all on function y_private.unset_departed_builders() from public, anon, authenticated, service_role;

drop trigger if exists team_members_unset_departed_builders on public.team_members;
create trigger team_members_unset_departed_builders
  after delete on public.team_members
  for each row execute function y_private.unset_departed_builders();

-- Rows already in that state (an owner who left before this migration).
with gone as (
  update public.products p set builder_agent_id = null, updated_at = now()
   where p.builder_agent_id is not null
     and not exists (select 1 from public.agents a join public.team_members m on m.user_id = a.owner_user_id
                      where a.id = p.builder_agent_id and m.team_id = p.owner_team_id)
  returning p.id
)
delete from public.thread_participants tp using public.threads t
 where tp.thread_id = t.id and t.kind = 'support' and t.product_id in (select id from gone)
   and tp.p_kind = 'agent' and tp.role = 'builder';
