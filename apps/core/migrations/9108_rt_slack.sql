-- apps/core local migration (owner: core slack). Red-team fixes for Slack.
-- Additive and idempotent; no policy is loosened (I7).

-- 1. (#52) When the Confirm prompt for a pending Slack instruction was posted.
--    A slack.event retry after a failed chat.postMessage re-posts the prompt
--    only while this is null (and the row is still pending and unexpired).
alter table public.slack_pending_instructions add column if not exists prompted_at timestamptz;

-- 2. (#94) A finished slack.event job (done or dead) keeps no Slack reply
--    text in public.jobs.payload: the text is needed only while the job can
--    still run, and the pending-instruction body is scrubbed on decision.
--    Retries (fail_job back to 'queued') keep it.
create or replace function y_private.jobs_scrub_slack_text()
returns trigger language plpgsql volatile security invoker set search_path = ''
as $fn$
begin
  new.payload := new.payload - 'text';
  return new;
end
$fn$;
revoke all on function y_private.jobs_scrub_slack_text() from public, anon, authenticated;
drop trigger if exists jobs_scrub_slack_text on public.jobs;
create trigger jobs_scrub_slack_text before update of state on public.jobs
  for each row when (new.topic = 'slack.event' and new.state in ('done', 'dead') and new.payload ? 'text')
  execute function y_private.jobs_scrub_slack_text();

-- Already finished slack.event jobs from before this migration.
update public.jobs set payload = payload - 'text'
 where topic = 'slack.event' and state in ('done', 'dead') and payload ? 'text';
