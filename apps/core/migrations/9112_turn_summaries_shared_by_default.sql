-- Turn summaries are shared with the author's team by default (product decision,
-- 2026-10-20). 9111 made them owner-only until the author opted in; now only an
-- explicit opt-out (update_sharing.share_with_team = false) keeps them private.
-- Accepting the team policy still counts as sharing. Moderation (quarantined or
-- suspicious/malicious activities) still hides a summary from teammates.

alter table public.update_sharing alter column share_with_team set default true;

create or replace function y_private.turn_summary_shared(p_owner uuid, p_team uuid, p_activity y_private.ulid)
returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select y_private.is_team_member(p_team)
     and exists (select 1 from public.team_members m
                  where m.team_id = p_team and m.user_id = p_owner
                    and (m.policy_accepted_version is not null
                         or not exists (select 1 from public.update_sharing u
                                         where u.user_id = p_owner and not u.share_with_team)))
     and (p_activity is null
          or not exists (select 1 from public.activities a
                          where a.id = p_activity
                            and (a.status in ('quarantined', 'rejected')
                                 or a.screen_label in ('suspicious', 'malicious'))))
$fn$;

revoke all on function y_private.turn_summary_shared(uuid, uuid, y_private.ulid) from public, anon;
grant execute on function y_private.turn_summary_shared(uuid, uuid, y_private.ulid) to authenticated, service_role;

-- Summaries written owner-only under 9111 get their team, when the activity has
-- one and the author is still on it; read-time sharing above decides visibility.
update public.turn_summaries t
   set team_id = a.team_id
  from public.activities a
 where t.team_id is null
   and t.activity_id = a.id
   and a.team_id is not null
   and exists (select 1 from public.team_members m where m.team_id = a.team_id and m.user_id = t.owner_user_id);
