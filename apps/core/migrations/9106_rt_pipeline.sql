-- apps/core local migration (owner: core pipeline). Red-team fixes.
--
-- I6 ("digests are deleted within 24 h"): api.purge_expired ran hourly with a
-- 24 h cutoff, so a never-distilled digest could outlive the bound by up to
-- one schedule period. The cutoff is now 23 h; everything else in the
-- function (0004_api.sql) is unchanged. The worker's close_idle backstop
-- uses the same margin, and server-mode core now runs this function hourly
-- from the job queue (Supabase still schedules it with pg_cron, 0007).
-- Idempotent (create or replace; grants restated).

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
  -- 23 h, not 24: this runs hourly, so a 24 h cutoff let digests live ~25 h (I6).
  update public.activity_chunks
     set digest_enc = null, error_episodes = '[]'::jsonb, local_distill = null, digest_purged_at = now()
   where (digest_enc is not null or local_distill is not null or error_episodes <> '[]'::jsonb)
     and (received_at < now() - interval '23 hours' or distilled_at is not null);
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

revoke all on function api.purge_expired() from public, anon, authenticated;
grant execute on function api.purge_expired() to service_role;
