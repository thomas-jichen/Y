-- 0004_api.sql
--
-- Functions core calls, in schema `api`. SECURITY INVOKER unless stated, so
-- RLS applies to the caller. The SECURITY DEFINER ones touch service-only
-- tables (rate_buckets, jobs, events, ...) and validate their inputs and the
-- caller's rights themselves. EXECUTE is granted per function at the end.
--
-- | function                     | mode     | callers                    |
-- |------------------------------|----------|----------------------------|
-- | search_network               | invoker  | anon, authenticated, svc   |
-- | match_error_signature        | invoker  | authenticated, svc         |
-- | feed_activities              | invoker  | anon, authenticated, svc   |
-- | decide_review                | invoker  | authenticated (human), svc |
-- | take_token                   | definer  | authenticated, svc         |
-- | enqueue_job                  | definer  | authenticated, svc         |
-- | claim_jobs/complete/fail_job | invoker  | service_role only          |
-- | emit_event                   | definer  | authenticated (user ctx)   |
-- | emit_system_event            | invoker  | service_role only          |
-- | events_since                 | invoker  | service_role only          |
-- | my_events                    | definer  | authenticated              |
-- | resolve_install_token        | definer  | anon, authenticated, svc   |
-- | resolve_agent_handle         | definer  | authenticated, svc         |
-- | accept_team_invite           | definer  | authenticated (human)      |
-- | complete_slack_link          | definer  | authenticated (web)        |
-- | rotate_channel_secret        | definer  | authenticated (owner)      |
-- | purge_expired                | invoker  | service_role only          |

-- ======================================================================= search

-- Hybrid search over highlights (PLAN §8): reciprocal rank fusion (k = 60)
-- of three lists of up to 40 each:
--   1. pgvector  ORDER BY embedding <=> qv LIMIT 40 (HNSW, cosine distance)
--   2. FTS       websearch_to_tsquery('english', q), ranked by ts_rank_cd
--   3. trigram   highlight_errors.sig % err (pg_trgm), ranked by similarity
-- Every list filters status = 'active' and screen_action in (allow, label);
-- RLS (security invoker) limits rows to what the caller may read, so a
-- signed-out caller searches public highlights only.
-- p_scope: 'all' | 'team' (anything not public) | 'public'.
-- Returns raw signals; core applies the final score and the 0.25 search /
-- 0.6 push thresholds (packages/retrieval). Any of q, qv, err may be null.
create or replace function api.search_network(
  q text,
  qv vector(384),
  err text,
  k integer,
  p_scope text default 'all'
) returns table (
  highlight_id text,
  rrf_score double precision,
  vector_rank integer,
  fts_rank integer,
  trigram_rank integer,
  vector_distance double precision,
  fts_score real,
  trigram_similarity real
)
language sql stable security invoker parallel safe
set search_path = pg_catalog, public, extensions
as $fn$
  with
  vec as (
    select h.id, (h.embedding <=> qv)::double precision as distance
    from public.highlights h
    where qv is not null
      and h.embedding is not null
      and h.status = 'active'
      and h.screen_action in ('allow', 'label')
      and (p_scope = 'all'
           or (p_scope = 'public' and h.visibility = 'public')
           or (p_scope = 'team' and h.visibility <> 'public'))
    order by h.embedding <=> qv
    limit 40
  ),
  vec_ranked as (
    select id, distance, row_number() over (order by distance, id)::integer as rank from vec
  ),
  fts as (
    select h.id, ts_rank_cd(h.fts, tq.query) as score
    from public.highlights h,
         lateral (select websearch_to_tsquery('english', q) as query) tq
    where nullif(btrim(q), '') is not null
      and h.fts @@ tq.query
      and h.status = 'active'
      and h.screen_action in ('allow', 'label')
      and (p_scope = 'all'
           or (p_scope = 'public' and h.visibility = 'public')
           or (p_scope = 'team' and h.visibility <> 'public'))
    order by score desc, h.id
    limit 40
  ),
  fts_ranked as (
    select id, score, row_number() over (order by score desc, id)::integer as rank from fts
  ),
  trgm as (
    select e.highlight_id as id, max(similarity(e.sig, err)) as sim
    from public.highlight_errors e
    join public.highlights h on h.id = e.highlight_id
    where nullif(btrim(err), '') is not null
      and e.sig % err
      and h.status = 'active'
      and h.screen_action in ('allow', 'label')
      and (p_scope = 'all'
           or (p_scope = 'public' and h.visibility = 'public')
           or (p_scope = 'team' and h.visibility <> 'public'))
    group by e.highlight_id
    order by sim desc, e.highlight_id
    limit 40
  ),
  trgm_ranked as (
    select id, sim, row_number() over (order by sim desc, id)::integer as rank from trgm
  ),
  ids as (
    select id from vec_ranked union select id from fts_ranked union select id from trgm_ranked
  ),
  fused as (
    select i.id,
           (coalesce(1.0 / (60 + v.rank), 0) + coalesce(1.0 / (60 + f.rank), 0) + coalesce(1.0 / (60 + t.rank), 0))
             ::double precision as rrf_score,
           v.rank as vector_rank, f.rank as fts_rank, t.rank as trigram_rank,
           v.distance, f.score, t.sim
    from ids i
    left join vec_ranked v on v.id = i.id
    left join fts_ranked f on f.id = i.id
    left join trgm_ranked t on t.id = i.id
  )
  select fused.id::text as highlight_id,
         fused.rrf_score,
         fused.vector_rank,
         fused.fts_rank,
         fused.trigram_rank,
         fused.distance as vector_distance,
         fused.score as fts_score,
         fused.sim as trigram_similarity
  from fused
  order by fused.rrf_score desc, fused.id
  limit greatest(1, least(coalesce(k, 8), 50))
$fn$;
comment on function api.search_network(text, vector, text, integer, text) is
  'RRF (k=60) over vector, FTS and trigram lists of active, allow|label highlights the caller may read.';

-- RLS and the status filters run after HNSW returns its candidates. pgvector
-- >= 0.8 can keep scanning until the LIMIT is met (results are re-ranked by
-- distance above). Older pgvector rejects the setting, so it is optional.
do $iterative$
begin
  alter function api.search_network(text, vector, text, integer, text) set hnsw.iterative_scan = 'relaxed_order';
exception when others then
  raise notice 'y 0004: hnsw.iterative_scan unavailable (%); search_network uses plain HNSW scans', sqlerrm;
end
$iterative$;

-- Error-signature match for POST /hook/match (P2 pointers). Trigram only,
-- and only screen_action = 'allow': labelled items are never pushed.
create or replace function api.match_error_signature(err text, k integer default 1)
returns table (highlight_id text, similarity real, visibility text, owner_user_id uuid)
language sql stable security invoker parallel safe
set search_path = pg_catalog, public, extensions
as $fn$
  select e.highlight_id::text, max(similarity(e.sig, err)) as sim, h.visibility::text, h.owner_user_id
  from public.highlight_errors e
  join public.highlights h on h.id = e.highlight_id
  where nullif(btrim(err), '') is not null
    and e.sig % err
    and h.status = 'active'
    and h.screen_action = 'allow'
  group by e.highlight_id, h.visibility, h.owner_user_id
  order by sim desc, e.highlight_id
  limit greatest(1, least(coalesce(k, 1), 10))
$fn$;

-- ========================================================================= feed

-- Keyset page of published activities the caller may read, newest first.
-- Cursor = (published_at, id) of the last row of the previous page.
-- p_scope: 'all' | 'team' (p_team_id) | 'following' | 'mine' | 'public'.
create or replace function api.feed_activities(
  p_before_published_at timestamptz default null,
  p_before_id text default null,
  p_limit integer default 20,
  p_scope text default 'all',
  p_team_id uuid default null
) returns setof public.activities
language sql stable security invoker
set search_path = pg_catalog, public
as $fn$
  select a.*
  from public.activities a
  where a.status = 'published'
    and (p_before_published_at is null
         or (p_before_id is null and a.published_at < p_before_published_at)
         or (p_before_id is not null and (a.published_at, a.id::text) < (p_before_published_at, p_before_id)))
    and case coalesce(p_scope, 'all')
          when 'all' then true
          when 'team' then a.team_id = p_team_id
          when 'following' then exists (select 1 from public.follows f
                                        where f.follower_user_id = auth.uid() and f.agent_id = a.agent_id)
          when 'mine' then a.owner_user_id = auth.uid()
          when 'public' then a.visibility = 'public'
          else false
        end
  order by a.published_at desc, a.id desc
  limit greatest(1, least(coalesce(p_limit, 20), 100))
$fn$;

-- ===================================================================== reviews

-- Compare-and-set decision on a review item. Returns the updated row, or NO
-- row when the item is not pending any more (already decided, expired) or
-- not the caller's: a second click gets nothing back and core answers 409.
-- Requires human context (via 'web' or 'slack' matching the claims), except
-- for service_role, which may also record 'native_prompt' decisions.
-- p_state: 'approved' | 'rejected'. p_decision defaults from p_state.
-- 'hold' is not a final decision: core applies it to the activity instead.
-- A decision_id reused for another item raises unique_violation (23505).
create or replace function api.decide_review(
  p_review_id text,
  p_state text,
  p_decision_id text,
  p_via text,
  p_decision text default null
) returns setof public.review_items
language plpgsql volatile security invoker
set search_path = pg_catalog, public
as $fn$
declare
  v_service boolean := y_private.is_service();
begin
  if p_state is null or p_state not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'decide_review: state must be approved or rejected';
  end if;
  if p_via is null or p_via not in ('web', 'slack', 'native_prompt') then
    raise exception using errcode = '22023', message = 'decide_review: via must be web, slack or native_prompt';
  end if;
  if p_decision is not null and p_decision not in ('approve', 'reject', 'release') then
    raise exception using errcode = '22023', message = 'decide_review: decision must be approve, reject or release';
  end if;
  if p_decision_id is null or p_decision_id !~ '^[A-Za-z0-9_.:-]{8,128}$' then
    raise exception using errcode = '22023', message = 'decide_review: decision_id must match ^[A-Za-z0-9_.:-]{8,128}$';
  end if;
  if not v_service then
    if not y_private.is_human() then
      raise exception using errcode = '42501',
        message = 'decide_review: decisions need a human context (web session or linked Slack user)';
    end if;
    if p_via is distinct from y_private.jwt_claim('via') then
      raise exception using errcode = '42501', message = 'decide_review: via must match the request context';
    end if;
  end if;

  return query
    update public.review_items r
       set state = p_state,
           decision = coalesce(p_decision, case p_state when 'approved' then 'approve' else 'reject' end),
           decision_id = p_decision_id,
           decided_by = coalesce(auth.uid(), r.owner_user_id),
           decided_via = p_via,
           decided_at = now()
     where r.id = p_review_id
       and r.state = 'pending'
       and (r.expires_at is null or r.expires_at > now())
    returning r.*;
end
$fn$;

-- ================================================================= rate limits

-- Token bucket (PLAN §10). Capacity p_burst, refilled continuously at p_rate
-- tokens per second; starts full. Takes p_cost tokens when available.
-- For a limit of N per window W seconds: p_rate = N / W, p_burst = N.
-- retry_after_s is the wait until p_cost tokens exist (null when p_cost >
-- p_burst, i.e. never). Keys look like '<limit>:<subject>' (e.g.
-- 'mcp:agent:<uuid>'). Uses now(), so calls in one transaction see no refill.
create or replace function api.take_token(
  p_key text,
  p_cost double precision,
  p_rate double precision,
  p_burst double precision
) returns table (allowed boolean, remaining double precision, retry_after_s integer)
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_now timestamptz := now();
  v_tokens double precision;
  v_updated timestamptz;
begin
  if p_key is null or char_length(p_key) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'take_token: key must be 1..200 characters';
  end if;
  if p_cost is null or p_cost <= 0 or p_rate is null or p_rate <= 0 or p_burst is null or p_burst <= 0 then
    raise exception using errcode = '22023', message = 'take_token: cost, rate and burst must be positive';
  end if;

  insert into public.rate_buckets as b (key, tokens, updated_at)
  values (p_key, p_burst, v_now)
  on conflict (key) do nothing;

  select b.tokens, b.updated_at into v_tokens, v_updated
  from public.rate_buckets b where b.key = p_key
  for update;

  v_tokens := least(p_burst, v_tokens + p_rate * greatest(0, extract(epoch from (v_now - v_updated))::double precision));
  if v_tokens >= p_cost then
    v_tokens := v_tokens - p_cost;
    allowed := true;
    retry_after_s := 0;
  else
    allowed := false;
    retry_after_s := case when p_cost > p_burst then null else ceil((p_cost - v_tokens) / p_rate)::integer end;
  end if;
  remaining := v_tokens;

  update public.rate_buckets b
     set tokens = v_tokens, updated_at = greatest(v_now, v_updated)
   where b.key = p_key;
  return next;
end
$fn$;

-- ========================================================================= jobs

-- Enqueue a job. With a dedupe_key, enqueueing again returns the existing
-- job's id instead of creating another (keys are unique for the row's
-- lifetime; finished jobs are purged after 7 days).
create or replace function api.enqueue_job(
  p_topic text,
  p_payload jsonb default '{}'::jsonb,
  p_dedupe_key text default null,
  p_run_after timestamptz default null,
  p_max_attempts integer default 5
) returns bigint
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_id bigint;
begin
  insert into public.jobs (topic, payload, dedupe_key, run_after, max_attempts)
  values (p_topic, coalesce(p_payload, '{}'::jsonb), p_dedupe_key, coalesce(p_run_after, now()), coalesce(p_max_attempts, 5))
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then
    select j.id into v_id from public.jobs j where j.dedupe_key = p_dedupe_key;
  end if;
  return v_id;
end
$fn$;

-- Claim up to p_n due jobs on p_topics for p_lease, skipping rows other
-- workers hold (FOR UPDATE SKIP LOCKED). A job is due when queued with
-- run_after <= now(), or running with an expired lease (its worker died).
-- Expired leases on the last attempt are marked dead first. Each claim
-- increments attempts; pass that value back to complete_job/fail_job as a
-- fencing token so a worker whose lease expired cannot finish a reclaimed job.
create or replace function api.claim_jobs(p_topics text[], p_n integer, p_lease interval)
returns setof public.jobs
language plpgsql volatile security invoker
set search_path = pg_catalog, public
as $fn$
begin
  if p_topics is null or cardinality(p_topics) = 0 then
    raise exception using errcode = '22023', message = 'claim_jobs: topics must not be empty';
  end if;
  if p_lease is null or p_lease <= interval '0' or p_lease > interval '1 hour' then
    raise exception using errcode = '22023', message = 'claim_jobs: lease must be within (0, 1 hour]';
  end if;

  update public.jobs j
     set state = 'dead', locked_until = null, finished_at = now(),
         last_error = coalesce(j.last_error, 'lease expired on the last attempt')
   where j.state = 'running' and j.locked_until < now() and j.attempts >= j.max_attempts
     and j.topic = any (p_topics);

  return query
    with picked as (
      select j.id
      from public.jobs j
      where j.topic = any (p_topics)
        and j.attempts < j.max_attempts
        and ((j.state = 'queued' and j.run_after <= now())
             or (j.state = 'running' and j.locked_until < now()))
      order by j.run_after, j.id
      limit greatest(1, least(coalesce(p_n, 1), 100))
      for update skip locked
    )
    update public.jobs j
       set state = 'running', attempts = j.attempts + 1, locked_until = now() + p_lease, started_at = now()
      from picked
     where j.id = picked.id
    returning j.*;
end
$fn$;

-- Mark a claimed job done. Returns false when the job is not running (or the
-- fencing token p_attempts does not match).
create or replace function api.complete_job(p_id bigint, p_attempts integer default null)
returns boolean
language sql volatile security invoker
set search_path = pg_catalog, public
as $fn$
  with done as (
    update public.jobs j
       set state = 'done', locked_until = null, finished_at = now(), last_error = null
     where j.id = p_id and j.state = 'running' and (p_attempts is null or j.attempts = p_attempts)
    returning 1
  )
  select exists (select 1 from done)
$fn$;

-- Record a failure: requeue with backoff (p_retry_in, else 5 s x 2^attempts,
-- capped at 1 h) or mark dead after max_attempts. Returns the new state, or
-- null when the job is not running (or the fencing token does not match).
-- Keep p_error free of user content (ids and error classes only).
create or replace function api.fail_job(
  p_id bigint,
  p_error text,
  p_retry_in interval default null,
  p_attempts integer default null
) returns text
language sql volatile security invoker
set search_path = pg_catalog, public
as $fn$
  update public.jobs j
     set state = case when j.attempts >= j.max_attempts then 'dead' else 'queued' end,
         run_after = case when j.attempts >= j.max_attempts then j.run_after
                          else now() + coalesce(p_retry_in,
                                                least(interval '1 hour', interval '5 seconds' * power(2, least(j.attempts, 20))))
                     end,
         locked_until = null,
         finished_at = case when j.attempts >= j.max_attempts then now() end,
         last_error = left(coalesce(p_error, 'failed'), 2000)
   where j.id = p_id and j.state = 'running' and (p_attempts is null or j.attempts = p_attempts)
  returning j.state
$fn$;

-- ======================================================================= events

-- Insert an events row from a user context (fan-out happens in the 0005
-- trigger: pg_notify plus Supabase Realtime broadcast). Payloads are
-- ids/ints/booleans only (CHECK on events.payload); use wire (prefixed) ids,
-- e.g. {"activityId": "a_..."}.
-- * System types (kill_switch.changed, takedown, wake.requested) are reserved
--   for service_role via api.emit_system_event.
-- * Trigger-owned types (review.new, review.decided, change.updated) are
--   emitted by the 0005 triggers only.
-- * Every audience member must be someone the caller may notify
--   (y_private.can_notify_user: self, teammates, org co-members,
--   accepted friends, thread co-participants), and audience agents must
--   belong to such users, so a user context can never ping arbitrary people.
-- The worker (service_role) uses api.emit_system_event, which has no checks.
create or replace function api.emit_event(
  p_type text,
  p_audience_agent_ids uuid[],
  p_audience_user_ids uuid[],
  p_payload jsonb default '{}'::jsonb
) returns bigint
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_id bigint;
begin
  if p_type in ('kill_switch.changed', 'takedown', 'wake.requested') then
    raise exception using errcode = '42501', message = format('emit_event: %s is a system event', p_type);
  end if;
  if p_type in ('review.new', 'review.decided', 'change.updated') then
    raise exception using errcode = '42501', message = format('emit_event: %s is emitted by triggers only', p_type);
  end if;
  if exists (select 1 from unnest(coalesce(p_audience_user_ids, '{}')) as u(id)
             where not y_private.can_notify_user(u.id)) then
    raise exception using errcode = '42501', message = 'emit_event: audience includes a user the caller may not notify';
  end if;
  if exists (select 1 from unnest(coalesce(p_audience_agent_ids, '{}')) as x(id)
             where not exists (select 1 from public.agents a
                               where a.id = x.id and y_private.can_notify_user(a.owner_user_id))) then
    raise exception using errcode = '42501', message = 'emit_event: audience includes an agent the caller may not notify';
  end if;
  insert into public.events (type, audience_agent_ids, audience_user_ids, payload)
  values (p_type, coalesce(p_audience_agent_ids, '{}'), coalesce(p_audience_user_ids, '{}'), coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end
$fn$;

create or replace function api.emit_system_event(
  p_type text,
  p_audience_agent_ids uuid[],
  p_audience_user_ids uuid[],
  p_payload jsonb default '{}'::jsonb
) returns bigint
language sql volatile security invoker
set search_path = pg_catalog, public
as $fn$
  insert into public.events (type, audience_agent_ids, audience_user_ids, payload)
  values (p_type, coalesce(p_audience_agent_ids, '{}'), coalesce(p_audience_user_ids, '{}'), coalesce(p_payload, '{}'::jsonb))
  returning id
$fn$;

-- Events after a cursor, for core's in-process bus (it LISTENs on
-- y_events, whose payload is just the id, then reads from here).
-- `notify` is the packages/schema EventRecord JSON (camelCase).
create or replace function api.events_since(p_after bigint, p_limit integer default 500)
returns table (
  id bigint,
  type text,
  audience_agent_ids uuid[],
  audience_user_ids uuid[],
  payload jsonb,
  created_at timestamptz,
  notify jsonb
)
language sql stable security invoker
set search_path = pg_catalog, public
as $fn$
  select e.id, e.type, e.audience_agent_ids, e.audience_user_ids, e.payload, e.created_at,
         jsonb_build_object('id', e.id::text, 'type', e.type,
                            'audienceAgentIds', to_jsonb(e.audience_agent_ids),
                            'audienceUserIds', to_jsonb(e.audience_user_ids),
                            'payload', e.payload)
  from public.events e
  where e.id > coalesce(p_after, 0)
  order by e.id
  limit greatest(1, least(coalesce(p_limit, 500), 5000))
$fn$;

-- The caller's events after a cursor (SSE Last-Event-ID resume, /pulse):
-- addressed to the user (human context) or to an agent the caller may act as.
create or replace function api.my_events(p_after bigint, p_limit integer default 100)
returns table (id bigint, type text, payload jsonb, created_at timestamptz)
language sql stable security definer
set search_path = ''
as $fn$
  select e.id, e.type, e.payload, e.created_at
  from public.events e
  where e.id > coalesce(p_after, 0)
    and auth.uid() is not null
    and (
      (not y_private.is_agent_context() and e.audience_user_ids @> array[auth.uid()])
      or e.audience_agent_ids && array(
           select a.id from public.agents a
           where a.owner_user_id = auth.uid()
             and (y_private.acting_agent_id() is null or a.id = y_private.acting_agent_id()))
    )
  order by e.id
  limit greatest(1, least(coalesce(p_limit, 100), 1000))
$fn$;

-- =============================================================== identity helpers

-- Install token verification (sha256 lookup; core caches for 60 s). Callable
-- before any user context exists. Returns no row for unknown hashes.
create or replace function api.resolve_install_token(p_token_hash text)
returns table (
  install_id uuid,
  agent_id uuid,
  owner_user_id uuid,
  agent_handle text,
  harness text,
  revoked boolean,
  agent_status text,
  user_status text
)
language sql stable security definer
set search_path = ''
as $fn$
  select i.id, a.id, a.owner_user_id, a.handle::text, a.harness::text, i.revoked_at is not null, a.status, u.status
  from public.installs i
  join public.agents a on a.id = i.agent_id
  join public.users u on u.id = a.owner_user_id
  where i.token_hash = p_token_hash
$fn$;

-- Resolve '@handle' (or 'handle') to an active agent, for send_message
-- addressing. Lets a sender address agents whose owners it cannot see; the
-- DM itself still goes through permissions and the request flow (I4).
create or replace function api.resolve_agent_handle(p_handle text)
returns table (agent_id uuid, owner_user_id uuid, harness text)
language sql stable security definer
set search_path = ''
as $fn$
  select a.id, a.owner_user_id, a.harness::text
  from public.agents a
  join public.users u on u.id = a.owner_user_id
  where a.handle = lower(ltrim(p_handle, '@'))
    and a.status = 'active' and u.status = 'active'
    and auth.uid() is not null
$fn$;

-- Join a team with an invite link token (sha256). Human context only.
create or replace function api.accept_team_invite(p_token_hash text)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_invite public.team_invites%rowtype;
begin
  if not y_private.is_human() then
    raise exception using errcode = '42501', message = 'accept_team_invite: requires a human (web) context';
  end if;
  select * into v_invite from public.team_invites i where i.token_hash = p_token_hash for update;
  if not found or v_invite.revoked_at is not null or v_invite.expires_at <= now()
     or v_invite.uses >= v_invite.max_uses then
    raise exception using errcode = 'P0002', message = 'accept_team_invite: invite is invalid, used up or expired';
  end if;
  insert into public.team_members (team_id, user_id, role)
  values (v_invite.team_id, auth.uid(), v_invite.role)
  on conflict (team_id, user_id) do nothing;
  update public.team_invites set uses = uses + 1 where id = v_invite.id;
  return v_invite.team_id;
end
$fn$;

-- Complete `/y connect`: link the Slack user behind a single-use
-- token to the signed-in web user. Requires via = 'web'.
create or replace function api.complete_slack_link(p_token_hash text)
returns table (slack_team_id text, slack_user_id text)
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_token public.slack_link_tokens%rowtype;
begin
  if not y_private.is_human() or y_private.jwt_claim('via') <> 'web' then
    raise exception using errcode = '42501', message = 'complete_slack_link: requires a signed-in web session';
  end if;
  select * into v_token from public.slack_link_tokens t where t.token_hash = p_token_hash for update;
  if not found or v_token.used_at is not null or v_token.expires_at <= now() then
    raise exception using errcode = 'P0002', message = 'complete_slack_link: link is invalid, used or expired';
  end if;
  delete from public.slack_identity_links l
   where l.user_id = auth.uid() and l.slack_team_id = v_token.slack_team_id;
  insert into public.slack_identity_links (slack_team_id, slack_user_id, user_id, slack_team_name)
  values (v_token.slack_team_id, v_token.slack_user_id, auth.uid(),
          (select i.team_name from public.slack_installations i where i.slack_team_id = v_token.slack_team_id))
  on conflict on constraint slack_identity_links_pkey
    do update set user_id = excluded.user_id, slack_team_name = excluded.slack_team_name,
                  linked_at = now(), revoked_at = null;
  update public.slack_link_tokens set used_at = now(), used_by = auth.uid() where token_hash = p_token_hash;
  slack_team_id := v_token.slack_team_id;
  slack_user_id := v_token.slack_user_id;
  return next;
end
$fn$;

-- Rotate a Realtime channel secret (the old topic stops receiving). Users
-- rotate their own (human context); agents rotate their own.
create or replace function api.rotate_channel_secret(p_owner_kind text, p_owner_id uuid)
returns text
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_secret text;
begin
  if p_owner_kind = 'user' then
    if p_owner_id is distinct from auth.uid() or not y_private.is_human() then
      raise exception using errcode = '42501', message = 'rotate_channel_secret: not your channel';
    end if;
  elsif p_owner_kind = 'agent' then
    if not y_private.agent_ok(p_owner_id) then
      raise exception using errcode = '42501', message = 'rotate_channel_secret: not your channel';
    end if;
  else
    raise exception using errcode = '22023', message = 'rotate_channel_secret: owner_kind must be user or agent';
  end if;
  insert into public.realtime_channels as c (owner_kind, owner_id)
  values (p_owner_kind, p_owner_id)
  on conflict (owner_kind, owner_id)
    do update set secret = y_private.random_hex64(), rotated_at = now()
  returning c.secret into v_secret;
  return v_secret;
end
$fn$;

-- ================================================================== retention

-- Free-tier retention (500 MB): events 7 d, digests 24 h (I6), finished jobs
-- 7 d, Slack dedupe 3 d, idle buckets/leases/ledger, expired link tokens, and
-- expiry of overdue review items. Scheduled hourly by 0007 when pg_cron
-- exists; the worker can call it too. Returns per-table counts.
create or replace function api.purge_expired()
returns jsonb
language plpgsql volatile security invoker
set search_path = pg_catalog, public
as $fn$
declare
  v_events bigint;
  v_digests bigint;
  v_jobs bigint;
  v_slack bigint;
  v_buckets bigint;
  v_leases bigint;
  v_ledger bigint;
  v_tokens bigint;
  v_reviews bigint;
begin
  delete from public.events where created_at < now() - interval '7 days';
  get diagnostics v_events = row_count;
  -- Every transcript-derived column: the digest, error excerpts and the local
  -- distill result (copied into activities/highlights by the worker first).
  update public.activity_chunks
     set digest_enc = null, error_episodes = '[]'::jsonb, local_distill = null, digest_purged_at = now()
   where (digest_enc is not null or local_distill is not null or error_episodes <> '[]'::jsonb)
     and (received_at < now() - interval '24 hours' or distilled_at is not null);
  get diagnostics v_digests = row_count;
  delete from public.jobs where state in ('done', 'dead') and finished_at < now() - interval '7 days';
  get diagnostics v_jobs = row_count;
  delete from public.slack_events_seen where seen_at < now() - interval '3 days';
  get diagnostics v_slack = row_count;
  delete from public.rate_buckets where updated_at < now() - interval '2 days';
  get diagnostics v_buckets = row_count;
  delete from public.session_leases where last_heartbeat_at < now() - interval '1 day';
  get diagnostics v_leases = row_count;
  delete from public.wake_ledger where at < now() - interval '2 days';
  get diagnostics v_ledger = row_count;
  delete from public.slack_link_tokens where expires_at < now() - interval '1 day';
  get diagnostics v_tokens = row_count;
  update public.review_items set state = 'expired' where state = 'pending' and expires_at <= now();
  get diagnostics v_reviews = row_count;
  return jsonb_build_object('events', v_events, 'digests', v_digests, 'jobs', v_jobs, 'slackEvents', v_slack,
                            'rateBuckets', v_buckets, 'sessionLeases', v_leases, 'wakeLedger', v_ledger,
                            'slackLinkTokens', v_tokens, 'reviewItemsExpired', v_reviews);
end
$fn$;

-- ======================================================================= grants

revoke all on all functions in schema api from public, anon, authenticated, service_role;

grant execute on function api.search_network(text, vector, text, integer, text) to anon, authenticated, service_role;
grant execute on function api.match_error_signature(text, integer) to authenticated, service_role;
grant execute on function api.feed_activities(timestamptz, text, integer, text, uuid) to anon, authenticated, service_role;
grant execute on function api.decide_review(text, text, text, text, text) to authenticated, service_role;
grant execute on function api.take_token(text, double precision, double precision, double precision)
  to authenticated, service_role;
grant execute on function api.enqueue_job(text, jsonb, text, timestamptz, integer) to authenticated, service_role;
grant execute on function api.claim_jobs(text[], integer, interval) to service_role;
grant execute on function api.complete_job(bigint, integer) to service_role;
grant execute on function api.fail_job(bigint, text, interval, integer) to service_role;
grant execute on function api.emit_event(text, uuid[], uuid[], jsonb) to authenticated;
grant execute on function api.emit_system_event(text, uuid[], uuid[], jsonb) to service_role;
grant execute on function api.events_since(bigint, integer) to service_role;
grant execute on function api.my_events(bigint, integer) to authenticated;
grant execute on function api.resolve_install_token(text) to anon, authenticated, service_role;
grant execute on function api.resolve_agent_handle(text) to authenticated, service_role;
grant execute on function api.accept_team_invite(text) to authenticated;
grant execute on function api.complete_slack_link(text) to authenticated;
grant execute on function api.rotate_channel_secret(text, uuid) to authenticated;
grant execute on function api.purge_expired() to service_role;
