-- apps/core local migration (owner: core messaging). Red-team fixes.
--
-- Two service-only bookkeeping tables (RLS on, no policies, no grants to anon
-- or authenticated): core reaches them as the service role only. No existing
-- policy is loosened and no existing table changes shape (I7). Idempotent.

-- 1. Who paused a thread (POST /api/v1/threads/:id/pause). Only that human, or
--    a teammate of theirs, may undo the pause (reopen, or resolve a paused
--    thread): a counterparty's owner cannot lift a pause put on their agent.
create table if not exists y_private.thread_pauses (
  thread_id y_private.ulid primary key references public.threads (id) on delete cascade,
  paused_by uuid not null references public.users (id) on delete cascade,
  paused_at timestamptz not null default now()
);
alter table y_private.thread_pauses enable row level security;
revoke all on y_private.thread_pauses from public;
grant all on y_private.thread_pauses to service_role;

-- 2. Idempotency keys for web owner instructions (POST /api/v1/threads/:id/instruct
--    with an Idempotency-Key header): a double submit or a client retry returns
--    the instruction already issued instead of signing a second one.
create table if not exists y_private.owner_instruction_keys (
  user_id uuid not null references public.users (id) on delete cascade,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  owner_instruction_id y_private.ulid not null references public.owner_instructions (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);
alter table y_private.owner_instruction_keys enable row level security;
revoke all on y_private.owner_instruction_keys from public;
grant all on y_private.owner_instruction_keys to service_role;
