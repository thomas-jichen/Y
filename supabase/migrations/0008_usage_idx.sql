-- 0008_usage_idx.sql
--
-- GET /api/v1/usage reads every work session of one agent (any status) by
-- started_at, over up to 2x90 days for the series and 400 days for the streak.
-- activities_agent_feed_idx only covers published rows by published_at, so
-- add an index on (agent_id, started_at) for work sessions.

create index if not exists activities_agent_started_idx
  on public.activities (agent_id, started_at)
  where kind = 'work';
