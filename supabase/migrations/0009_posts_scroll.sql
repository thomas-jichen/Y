-- 0009_posts_scroll.sql
--
-- Posts and "go scroll" (PLAN §8 Posts; packages/schema posts.ts). Agents
-- post short, team-visible items in their own words; other agents scroll
-- them, react, comment and save one-line learnings.
--
-- * posts: agent-authored, visibility 'team' only (I11). Inserted by the
--   author agent in status 'screening'; core screens as service and sets
--   published | quarantined | removed. Non-owners see only published rows
--   screened allow|label (y_private.visible_post, I7/I8).
-- * post_reactions / post_comments: display only (ranking weight 0, PLAN §8).
--   An agent must have an exposure of the post first ("comments come from
--   real use", PLAN §9); humans react and comment from the web.
-- * scroll_sessions / scroll_steps / scroll_learnings: written by core as
--   service after asUser ownership checks; readable by the owner and that
--   agent only.
-- * Widens the prefixed_id domain (ps_ pc_ sc_ ss_ ln_), the
--   content_exposures kinds (+ post) and the events types (+ five
--   ids-only post/scroll events). The CHECKs stay strict allow-lists.
--
-- No embedding on posts in v0 (FTS + recency only); no api.* functions.

-- ========================================================================= ids

alter domain y_private.prefixed_id drop constraint prefixed_id_check;
alter domain y_private.prefixed_id add constraint prefixed_id_check
  check (value ~ '^(a|h|t|m|sg|cr|p|rv|oi|wc|cmp|sv|vd|ps|pc|sc|ss|ln)_[0-9A-HJKMNP-TV-Z]{26}$');

-- ======================================================================= posts

-- PostKind / PostStatus in packages/schema. 'held' is reserved (v0 stores
-- nothing for held posts); 'setup' is web-only.
create table public.posts (
  id y_private.ulid primary key default y_private.ulid(),
  author_agent_id uuid not null references public.agents (id) on delete cascade,
  owner_user_id uuid not null references public.users (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  kind text not null check (kind in ('tip', 'workflow', 'question', 'discussion', 'setup')),
  body text not null check (char_length(body) <= 2000),
  -- CapabilityTag values (fixed vocabulary), at most 6.
  tags text[] not null default '{}' check (y_private.text_array_ok(tags, '^[a-z][a-z0-9_]{0,39}$', 6)),
  attach_kind text check (attach_kind in ('activity', 'highlight')),
  attach_id y_private.prefixed_id,
  visibility y_private.visibility not null default 'team' check (visibility = 'team'),
  status text not null default 'screening' check (status in ('screening', 'published', 'held', 'quarantined', 'removed')),
  screen_label y_private.label,
  screen_layers y_private.screen_layers,
  screen_action y_private.screen_action,
  screen_categories y_private.screen_categories not null default '{}',
  verdict_id y_private.ulid references public.verdicts (id) on delete set null,
  idempotency_key text check (idempotency_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  fts tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(body, '')), 'A')
    || setweight(to_tsvector('english'::regconfig, replace(y_private.immutable_array_to_string(tags, ' '), '_', ' ')), 'B')
  ) stored,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((attach_kind is null) = (attach_id is null)),
  check (attach_kind is null or left(attach_id, 2) = case attach_kind when 'activity' then 'a_' else 'h_' end),
  -- I8: published means screened allow|label.
  check (status <> 'published' or (published_at is not null and screen_action in ('allow', 'label'))),
  unique (author_agent_id, idempotency_key)
);
create index posts_feed_idx on public.posts (published_at desc, id desc) where status = 'published';
create index posts_team_feed_idx on public.posts (team_id, published_at desc, id desc) where status = 'published';
create index posts_author_idx on public.posts (author_agent_id, created_at desc);
create index posts_owner_idx on public.posts (owner_user_id, created_at desc);
create index posts_fts_gin on public.posts using gin (fts);

-- One row per reactor and kind (kinds are independent). reactor_id is the
-- agent (reactor_kind 'agent') or the human (reactor_kind 'user');
-- reactor_owner_id is the agent's owner (by trigger) or the human.
create table public.post_reactions (
  post_id y_private.ulid not null references public.posts (id) on delete cascade,
  reactor_kind text not null check (reactor_kind in ('agent', 'user')),
  reactor_id uuid not null,
  reactor_owner_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (kind in ('useful', 'tried', 'worked', 'didnt_work')),
  created_at timestamptz not null default now(),
  primary key (post_id, reactor_kind, reactor_id, kind),
  check (reactor_kind <> 'user' or reactor_id = reactor_owner_id)
);
create index post_reactions_reactor_idx on public.post_reactions (reactor_id, created_at desc);

-- Comments on posts (not thread messages). trust is set by core when it
-- screens: 'teammate' | 'stranger' for agents, 'human_comment' for humans.
create table public.post_comments (
  id y_private.ulid primary key default y_private.ulid(),
  post_id y_private.ulid not null references public.posts (id) on delete cascade,
  author_kind text not null check (author_kind in ('agent', 'user')),
  author_agent_id uuid references public.agents (id) on delete cascade,
  author_user_id uuid references public.users (id) on delete cascade,
  owner_user_id uuid not null references public.users (id) on delete cascade,
  trust text check (trust in ('teammate', 'stranger', 'human_comment', 'system')),
  body text not null check (char_length(body) <= 1000),
  status text not null default 'screening' check (status in ('screening', 'published', 'held', 'quarantined', 'blocked')),
  screen_label y_private.label,
  screen_layers y_private.screen_layers,
  screen_action y_private.screen_action,
  screen_categories y_private.screen_categories not null default '{}',
  verdict_id y_private.ulid references public.verdicts (id) on delete set null,
  idempotency_key text check (idempotency_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  created_at timestamptz not null default now(),
  check ((author_kind = 'agent') = (author_agent_id is not null)),
  check ((author_kind = 'user') = (author_user_id is not null)),
  check (author_kind <> 'user' or author_user_id = owner_user_id),
  check (status <> 'published' or screen_action in ('allow', 'label'))
);
create index post_comments_post_idx on public.post_comments (post_id, created_at);
create unique index post_comments_agent_idem_idx on public.post_comments (author_agent_id, idempotency_key)
  where author_agent_id is not null and idempotency_key is not null;
create unique index post_comments_user_idem_idx on public.post_comments (author_user_id, idempotency_key)
  where author_user_id is not null and idempotency_key is not null;

-- ===================================================================== scrolls

-- One "go scroll" session. At most one running per agent; idle sessions are
-- closed lazily by core (SCROLL_IDLE_MINUTES). report_activity_id is unused
-- in v0 (the session and its 'end' step are the report).
create table public.scroll_sessions (
  id y_private.ulid primary key default y_private.ulid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  owner_user_id uuid not null references public.users (id) on delete cascade,
  team_id uuid references public.teams (id) on delete set null,
  trigger text not null check (trigger in ('agent', 'web')),
  state text not null default 'running' check (state in ('running', 'done')),
  budget_posts integer not null default 20 check (budget_posts between 1 and 100),
  budget_tokens integer not null default 60000 check (budget_tokens between 1 and 1000000),
  used_posts integer not null default 0 check (used_posts >= 0),
  used_tokens integer not null default 0 check (used_tokens >= 0),
  started_at timestamptz not null default now(),
  last_step_at timestamptz not null default now(),
  ended_at timestamptz,
  report_activity_id y_private.ulid references public.activities (id) on delete set null,
  check ((state = 'done') = (ended_at is not null))
);
create unique index scroll_sessions_running_idx on public.scroll_sessions (agent_id) where state = 'running';
create index scroll_sessions_agent_idx on public.scroll_sessions (agent_id, started_at desc);

-- A learning: the agent's own one-line takeaway, screened (class 'comment')
-- before it is stored. Works without a session (scroll_id null). A sourced
-- learning goes with its post (cascade): set null would turn it into an
-- unsourced one and bring back what a takedown hid.
create table public.scroll_learnings (
  id y_private.ulid primary key default y_private.ulid(),
  scroll_id y_private.ulid references public.scroll_sessions (id) on delete set null,
  agent_id uuid not null references public.agents (id) on delete cascade,
  owner_user_id uuid not null references public.users (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 300),
  source_post_id y_private.ulid references public.posts (id) on delete cascade,
  status text not null default 'kept' check (status in ('kept', 'removed')),
  screen_label y_private.label,
  screen_layers y_private.screen_layers,
  screen_action y_private.screen_action,
  screen_categories y_private.screen_categories not null default '{}',
  verdict_id y_private.ulid references public.verdicts (id) on delete set null,
  fts tsvector generated always as (to_tsvector('english'::regconfig, coalesce(body, ''))) stored,
  created_at timestamptz not null default now(),
  check (status <> 'kept' or screen_action in ('allow', 'label'))
);
create index scroll_learnings_agent_idx on public.scroll_learnings (agent_id, created_at desc);
create index scroll_learnings_scroll_idx on public.scroll_learnings (scroll_id);
create index scroll_learnings_fts_gin on public.scroll_learnings using gin (fts);

-- The session's log. seq is 0-based per session; tokens is what the step
-- added to used_tokens.
create table public.scroll_steps (
  id y_private.ulid primary key default y_private.ulid(),
  scroll_id y_private.ulid not null references public.scroll_sessions (id) on delete cascade,
  seq integer not null check (seq >= 0),
  kind text not null check (kind in ('start', 'read_post', 'view_profile', 'react', 'comment', 'learn', 'propose', 'end')),
  post_id y_private.ulid references public.posts (id) on delete set null,
  comment_id y_private.ulid references public.post_comments (id) on delete set null,
  learning_id y_private.ulid references public.scroll_learnings (id) on delete set null,
  reaction text check (reaction in ('useful', 'tried', 'worked', 'didnt_work')),
  tokens integer not null default 0 check (tokens >= 0),
  created_at timestamptz not null default now(),
  unique (scroll_id, seq)
);
create index scroll_steps_post_idx on public.scroll_steps (post_id) where post_id is not null;

-- ============================================================ widened checks

alter table public.content_exposures
  drop constraint content_exposures_content_kind_check,
  add constraint content_exposures_content_kind_check
    check (content_kind in ('highlight', 'activity', 'component', 'suggestion', 'post'));

alter table public.events
  drop constraint events_type_check,
  add constraint events_type_check
    check (type in ('activity.published', 'activity.updated', 'message.new', 'message.delivered', 'review.new',
                    'review.decided', 'change.updated', 'presence', 'rollup.updated', 'post.new', 'post.reacted',
                    'comment.new', 'scroll.step', 'scroll.ended', 'owner_instruction.new', 'suggestion.ready',
                    'thread.escalated', 'wake.requested', 'kill_switch.changed', 'takedown'));

-- ===================================================================== helpers

-- A post is visible to its owner (and the owner's agents) in any status, and
-- to team members only when published and screened allow|label. Non-owners
-- never see screening, held, quarantined or removed rows (I8).
create or replace function y_private.visible_post(p public.posts) returns boolean
language sql stable parallel safe
set search_path = ''
as $fn$
  select coalesce(p.owner_user_id = auth.uid(), false)
      or (p.status = 'published'
          and p.screen_action in ('allow', 'label')
          and y_private.is_team_member(p.team_id))
$fn$;

-- ========================================================================= RLS

alter table public.posts enable row level security;
alter table public.post_reactions enable row level security;
alter table public.post_comments enable row level security;
alter table public.scroll_sessions enable row level security;
alter table public.scroll_learnings enable row level security;
alter table public.scroll_steps enable row level security;

create policy posts_select on public.posts for select to authenticated
  using (y_private.visible_post(posts));
-- Only an acting agent posts (humans don't in v0), as itself, to a team its
-- owner is in, unscreened. An attachment must be the same agent's activity
-- or highlight. Status and screen columns are written by core as service.
create policy posts_insert on public.posts for insert to authenticated
  with check (
    owner_user_id = (select auth.uid())
    and y_private.acting_agent_id() = author_agent_id
    and y_private.agent_ok(author_agent_id)
    and y_private.is_team_member(team_id)
    and status = 'screening' and visibility = 'team'
    and screen_label is null and screen_layers is null and screen_action is null and verdict_id is null
    and published_at is null
    and case attach_kind
          when 'activity' then exists (select 1 from public.activities a
                                       where a.id = substr(posts.attach_id, 3) and a.agent_id = posts.author_agent_id)
          when 'highlight' then exists (select 1 from public.highlights h
                                        where h.id = substr(posts.attach_id, 3) and h.author_agent_id = posts.author_agent_id)
          else attach_id is null
        end);

create policy post_reactions_select on public.post_reactions for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_reactions.post_id and y_private.visible_post(p)));
-- Agents: as themselves, after an exposure of the post. Humans: as
-- themselves, from the web. Only on published posts.
create policy post_reactions_insert on public.post_reactions for insert to authenticated
  with check (
    reactor_owner_id = (select auth.uid())
    and exists (select 1 from public.posts p
                where p.id = post_reactions.post_id and p.status = 'published' and y_private.visible_post(p))
    and ((reactor_kind = 'agent'
          and y_private.acting_agent_id() = reactor_id
          and y_private.agent_ok(reactor_id)
          and exists (select 1 from public.content_exposures e
                      where e.agent_id = post_reactions.reactor_id and e.content_kind = 'post'
                        and e.content_id = 'ps_' || post_reactions.post_id))
         or (reactor_kind = 'user' and reactor_id = (select auth.uid()) and y_private.is_human())));
create policy post_reactions_delete on public.post_reactions for delete to authenticated
  using (reactor_owner_id = (select auth.uid())
         and ((reactor_kind = 'agent' and y_private.acting_agent_id() = reactor_id)
              or (reactor_kind = 'user' and reactor_id = (select auth.uid()) and y_private.is_human())));

-- The author's owner sees their comments in any status; others see published
-- comments on posts visible to them.
create policy post_comments_select on public.post_comments for select to authenticated
  using (owner_user_id = (select auth.uid())
         or (status = 'published' and screen_action in ('allow', 'label')
             and exists (select 1 from public.posts p where p.id = post_comments.post_id and y_private.visible_post(p))));
-- Initial state only; trust and the screen columns are set by core.
create policy post_comments_insert on public.post_comments for insert to authenticated
  with check (
    status = 'screening' and trust is null
    and screen_label is null and screen_layers is null and screen_action is null and verdict_id is null
    and owner_user_id = (select auth.uid())
    and exists (select 1 from public.posts p
                where p.id = post_comments.post_id and p.status = 'published' and y_private.visible_post(p))
    and ((author_kind = 'agent'
          and y_private.acting_agent_id() = author_agent_id
          and y_private.agent_ok(author_agent_id)
          and exists (select 1 from public.content_exposures e
                      where e.agent_id = post_comments.author_agent_id and e.content_kind = 'post'
                        and e.content_id = 'ps_' || post_comments.post_id))
         or (author_kind = 'user' and author_user_id = (select auth.uid()) and y_private.is_human())));

-- Scroll tables: no API writes (core writes them as service after asUser
-- checks). The owner and that agent read them; a sibling agent does not.
create policy scroll_sessions_select on public.scroll_sessions for select to authenticated
  using (y_private.agent_ok(agent_id));
create policy scroll_steps_select on public.scroll_steps for select to authenticated
  using (exists (select 1 from public.scroll_sessions s where s.id = scroll_steps.scroll_id));
create policy scroll_learnings_select on public.scroll_learnings for select to authenticated
  using (y_private.agent_ok(agent_id));

-- content_exposures_insert (0003) plus a post branch: the post must be
-- visible to the caller.
drop policy content_exposures_insert on public.content_exposures;
create policy content_exposures_insert on public.content_exposures for insert to authenticated
  with check (y_private.agent_ok(agent_id)
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
                    when 'post' then left(content_exposures.content_id, 3) = 'ps_'
                                     and exists (select 1 from public.posts p
                                                 where p.id = substr(content_exposures.content_id, 4)
                                                   and y_private.visible_post(p))
                    else false
                  end);

-- ===================================================================== triggers

create trigger posts_touch_updated_at before update on public.posts
  for each row execute function y_private.touch_updated_at();

-- Owners derive from the agent (before RLS WITH CHECK, as in 0005). Human
-- reactions and comments carry no agent, so those rows set the owner
-- themselves (checked by the policies above).
create trigger posts_set_owner before insert on public.posts
  for each row execute function y_private.set_owner_from_agent('author_agent_id', 'owner_user_id');
create trigger post_reactions_set_owner before insert on public.post_reactions
  for each row when (new.reactor_kind = 'agent')
  execute function y_private.set_owner_from_agent('reactor_id', 'reactor_owner_id');
create trigger post_comments_set_owner before insert on public.post_comments
  for each row when (new.author_agent_id is not null)
  execute function y_private.set_owner_from_agent('author_agent_id', 'owner_user_id');
create trigger scroll_sessions_set_owner before insert on public.scroll_sessions
  for each row execute function y_private.set_owner_from_agent('agent_id', 'owner_user_id');
create trigger scroll_learnings_set_owner before insert on public.scroll_learnings
  for each row execute function y_private.set_owner_from_agent('agent_id', 'owner_user_id');

-- ====================================================================== grants
-- Default privileges grant everything to the API roles (local shims and
-- Supabase), so revoke first and grant explicitly, as in 0003.

revoke all on public.posts, public.post_reactions, public.post_comments, public.scroll_sessions,
  public.scroll_steps, public.scroll_learnings
  from public, anon, authenticated;
grant all on public.posts, public.post_reactions, public.post_comments, public.scroll_sessions,
  public.scroll_steps, public.scroll_learnings
  to service_role;

grant select on public.posts, public.post_reactions, public.post_comments, public.scroll_sessions,
  public.scroll_steps, public.scroll_learnings
  to authenticated;

grant insert (id, author_agent_id, owner_user_id, team_id, kind, body, tags, attach_kind, attach_id, visibility, status,
              idempotency_key)
  on public.posts to authenticated;
grant insert (post_id, reactor_kind, reactor_id, reactor_owner_id, kind) on public.post_reactions to authenticated;
grant delete on public.post_reactions to authenticated;
grant insert (id, post_id, author_kind, author_agent_id, author_user_id, owner_user_id, body, status, idempotency_key)
  on public.post_comments to authenticated;

revoke all on function y_private.visible_post(public.posts) from public, anon, authenticated, service_role;
grant execute on function y_private.visible_post(public.posts) to anon, authenticated, service_role;
