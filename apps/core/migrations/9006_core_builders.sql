-- apps/core local migration (owner: core builders). Builder approval queue (PLAN §6).
--
-- A builder agent's reply in a support thread waits as 'request_pending'
-- until the builder's own human approves it. 0003's messages_select lets
-- every participant's HUMAN read request_pending messages (the stranger-intro
-- review), which here would show the customer's human an unapproved draft.
-- In support threads, request_pending messages are readable only by their
-- sender's owner (the first clause). Everything else is unchanged; the policy
-- only gets narrower (I7). Idempotent.

create or replace function y_private.is_support_thread(p_thread_id text) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_thread_id is not null and exists (
    select 1 from public.threads t where t.id = p_thread_id and t.kind = 'support')
$fn$;
revoke all on function y_private.is_support_thread(text) from public, anon, authenticated, service_role;
grant execute on function y_private.is_support_thread(text) to authenticated, service_role;

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using ((sender_owner_id = (select auth.uid())
          and (y_private.acting_agent_id() is null or sender_id = y_private.acting_agent_id()))
         or (y_private.is_thread_participant(thread_id)
             and (state in ('delivered', 'released', 'expired')
                  or (state = 'quarantined' and y_private.is_human())
                  or (state = 'request_pending' and y_private.is_human()
                      and not y_private.is_support_thread(thread_id)))));

-- Support thread lookups (ask_builder reuses the caller's thread per product).
create index if not exists threads_product_idx on public.threads (product_id, created_at desc) where product_id is not null;

-- One builder_task per source message: a bug report can be delivered inline,
-- released from quarantine or accepted from a request (support.ts).
create unique index if not exists builder_tasks_source_message_idx
  on public.builder_tasks (source_message_id) where source_message_id is not null;
