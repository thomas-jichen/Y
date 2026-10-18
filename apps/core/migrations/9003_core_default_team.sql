-- apps/core local migration (owner: core). Temporary: one team for everyone.
--
-- Until team creation and invites exist, every user joins the team with slug
-- 'dev' (when it exists): existing users now, new users on insert. Activities
-- already posted privately because their owner had no team move to the team.

create or replace function y_private.join_default_team()
returns trigger
language plpgsql security definer
set search_path = ''
as $fn$
begin
  insert into public.team_members (team_id, user_id)
  select t.id, new.id from public.teams t where t.slug = 'dev'
  on conflict do nothing;
  return new;
end
$fn$;
revoke all on function y_private.join_default_team() from public;

drop trigger if exists users_join_default_team on public.users;
create trigger users_join_default_team
  after insert on public.users
  for each row execute function y_private.join_default_team();

insert into public.team_members (team_id, user_id)
select t.id, u.id from public.teams t cross join public.users u
where t.slug = 'dev'
on conflict do nothing;

update public.activities a
   set team_id = t.id,
       visibility = case when a.visibility = 'private' and a.status = 'published' then 'team' else a.visibility end,
       updated_at = now()
  from public.teams t
 where t.slug = 'dev' and a.team_id is null;
