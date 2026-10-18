-- apps/core local migration (owner: core mcp/posts). Red-team fixes. Idempotent.
--
-- 1. Thread subjects stay within the envelope's 120 UTF-16 units after NFKC
--    (#20). A team room's subject is the team name (ensure_team_room, 9004),
--    and inbox puts it into a message envelope whose `subject` is
--    max(120) after NFKC. A short name of NFKC-expanding characters
--    (U+FDFA is 18 characters after NFKC) made inbox fail validation for
--    every member. A BEFORE trigger rewrites only a subject that would not
--    fit: to its NFKC form with control characters folded to spaces, cut to
--    120 UTF-16 units. Every subject that fits today is stored unchanged.
--    Existing subjects that do not fit are rewritten once.
--
-- 2. A takedown hides a learning's text on the RLS entry point too (#90).
--    scroll_learnings_select (0009) let the owner read a learning whose
--    source post was taken down (agent reads and core's web view already
--    hide it: LEARNING_VISIBLE_SQL). The policy only gets narrower (I7):
--    unsourced learnings, and learnings whose source post is still
--    published allow/label, read as before. The source check is a definer
--    function so it depends on the post's status only, not on whether the
--    reader can still see the post.

create or replace function y_private.utf16_length(p text) returns integer
language plpgsql immutable parallel safe
set search_path = ''
as $fn$
declare
  n integer := 0;
  i integer;
begin
  if p is null then
    return null;
  end if;
  for i in 1 .. char_length(p) loop
    n := n + case when ascii(substr(p, i, 1)) > 65535 then 2 else 1 end;
  end loop;
  return n;
end
$fn$;

-- The subject to store: unchanged when its NFKC form fits 120 UTF-16 units,
-- else the NFKC form, control characters folded to spaces, cut to fit.
create or replace function y_private.fit_subject(p text) returns text
language plpgsql immutable parallel safe
set search_path = ''
as $fn$
declare
  v text;
  out text := '';
  c text;
  n integer := 0;
  w integer;
  i integer;
begin
  if p is null or p = '' then
    return p;
  end if;
  v := normalize(p, NFKC);
  if y_private.utf16_length(v) <= 120 then
    return p;
  end if;
  v := btrim(regexp_replace(v, '[[:cntrl:][:space:]]+', ' ', 'g'));
  for i in 1 .. char_length(v) loop
    c := substr(v, i, 1);
    w := case when ascii(c) > 65535 then 2 else 1 end;
    exit when n + w > 120;
    out := out || c;
    n := n + w;
  end loop;
  return btrim(out);
end
$fn$;

create or replace function y_private.threads_fit_subject() returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.subject := coalesce(y_private.fit_subject(new.subject), '');
  return new;
end
$fn$;

drop trigger if exists threads_fit_subject on public.threads;
create trigger threads_fit_subject before insert or update of subject on public.threads
  for each row execute function y_private.threads_fit_subject();

update public.threads
   set subject = y_private.fit_subject(subject)
 where subject is distinct from y_private.fit_subject(subject);

-- A learning's source post is still published allow/label (any reader).
create or replace function y_private.learning_source_ok(p_post_id text) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_post_id is null or exists (
    select 1 from public.posts p
     where p.id = p_post_id and p.status = 'published' and p.screen_action in ('allow', 'label'))
$fn$;
revoke all on function y_private.learning_source_ok(text) from public, anon, authenticated, service_role;
grant execute on function y_private.learning_source_ok(text) to authenticated, service_role;

drop policy if exists scroll_learnings_select on public.scroll_learnings;
create policy scroll_learnings_select on public.scroll_learnings for select to authenticated
  using (y_private.agent_ok(agent_id) and y_private.learning_source_ok(source_post_id));
