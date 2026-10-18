-- 0002_core.sql
--
-- Every table from docs/PLAN.md §4 plus the §8 "Added features" (orgs,
-- friendships, prompt feedback). RLS, policies and grants are in 0003; API
-- functions in 0004; triggers in 0005.
--
-- Conventions
-- * snake_case everywhere; the wire is camelCase and core maps.
-- * High-volume entities (activities, highlights, threads, messages, ...) use
--   bare ULIDs (paceline_private.ulid domain, default paceline_private.ulid()).
--   Core adds the wire prefix (a_, h_, t_, m_, sg_, cr_, p_, rv_, oi_, wc_,
--   cmp_, sv_, vd_). Foreign keys hold bare ULIDs.
-- * POLYMORPHIC references (review_items.ref_id, verdicts.content_id,
--   reports.target_id, outcome_events.subject_id, content_exposures.content_id)
--   hold the PREFIXED wire id, so they are self-describing.
-- * Users are auth.users.id (uuid). Agents, teams, orgs, installs, sessions
--   use uuid ids (opaque EntityIds on the wire).
-- * Handles are stored WITHOUT the leading '@' (^[a-z0-9-]{3,32}$, PLAN §5);
--   the wire form adds it. Users and agents share one handle namespace
--   (handle_registry), so '@x' is never ambiguous.
-- * Embeddings are vector(384) (Supabase gte-small; mock embedder at 384 in
--   tests), indexed with HNSW vector_cosine_ops.
-- * Enum-like columns are text with CHECK constraints (as domains below) that
--   mirror packages/schema. Change both together.
-- * "Screen" columns on screened content: screen_label, screen_layers,
--   screen_action, verdict_id. screen_action NULL means "not screened yet",
--   which every read path treats as not visible to others.

-- ===================================================================== helpers

-- Crockford base32 ULID (48-bit ms timestamp + 80 random bits). Uses
-- gen_random_uuid() for randomness, so no extension is required.
create or replace function paceline_private.ulid() returns text
language plpgsql volatile parallel safe
set search_path = pg_catalog
as $fn$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  -- Bytes 0..5 of a v4 UUID are fully random (version/variant bits live in
  -- bytes 6 and 8), so 6 + 4 bytes from two UUIDs give 80 random bits.
  rnd bytea := substring(uuid_send(gen_random_uuid()) from 1 for 6)
            || substring(uuid_send(gen_random_uuid()) from 1 for 4);
  result text := '';
  acc bigint;
  i int;
  j int;
begin
  for i in reverse 9..0 loop
    result := result || substr(alphabet, ((ms >> (5 * i)) & 31)::int + 1, 1);
  end loop;
  for i in 0..1 loop
    acc := 0;
    for j in 0..4 loop
      acc := (acc << 8) | get_byte(rnd, i * 5 + j);
    end loop;
    for j in reverse 7..0 loop
      result := result || substr(alphabet, ((acc >> (5 * j)) & 31)::int + 1, 1);
    end loop;
  end loop;
  return result;
end
$fn$;
comment on function paceline_private.ulid() is 'A new ULID (26 chars, Crockford base32, time-ordered at ms granularity).';

-- 64 lowercase hex chars from two random UUIDs (~244 random bits). Used for
-- per-team salts and Realtime channel secrets.
create or replace function paceline_private.random_hex64() returns text
language sql volatile parallel safe
set search_path = pg_catalog
as $fn$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$fn$;

-- array_to_string is STABLE (element output functions); text[] output is
-- immutable, so this wrapper is safe in generated columns.
create or replace function paceline_private.immutable_array_to_string(arr text[], sep text) returns text
language sql immutable parallel safe
set search_path = pg_catalog
as $fn$
  select coalesce(array_to_string(arr, sep), '')
$fn$;

-- Concatenates the string elements of a JSON array (non-strings ignored).
create or replace function paceline_private.jsonb_strings(j jsonb) returns text
language sql immutable parallel safe
set search_path = pg_catalog
as $fn$
  select coalesce(string_agg(e.value, ' '), '')
  from jsonb_array_elements_text(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end) as e(value)
$fn$;

-- True when every element matches `pattern` and there are at most `max_items`.
create or replace function paceline_private.text_array_ok(arr text[], pattern text, max_items int) returns boolean
language sql immutable parallel safe
set search_path = pg_catalog
as $fn$
  select arr is null
      or (cardinality(arr) <= max_items
          and not exists (select 1 from unnest(arr) as e(v) where e.v is null or e.v !~ pattern))
$fn$;

-- Event payloads are ids, integers and booleans only (invariant I3 and
-- packages/schema NotifyPayload): at most 16 keys, camelCase-ish keys,
-- strings limited to id characters.
create or replace function paceline_private.event_payload_ok(p jsonb) returns boolean
language sql immutable parallel safe
set search_path = pg_catalog
as $fn$
  select p is not null
     and jsonb_typeof(p) = 'object'
     and (select count(*) from jsonb_object_keys(p)) <= 16
     and not exists (
       select 1
       from jsonb_each(p) as e(key, value)
       where e.key !~ '^[a-zA-Z][a-zA-Z0-9]{0,31}$'
          or not (
               (jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') ~ '^[A-Za-z0-9_.:-]{1,64}$')
            or (jsonb_typeof(e.value) = 'number' and (e.value #>> '{}') ~ '^-?[0-9]{1,19}$')
            or jsonb_typeof(e.value) = 'boolean'
          )
     )
$fn$;

-- ===================================================================== domains
-- Mirrors of packages/schema enums and id grammars.

create domain paceline_private.ulid as text
  check (value ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
create domain paceline_private.prefixed_id as text
  check (value ~ '^(a|h|t|m|sg|cr|p|rv|oi|wc|cmp|sv|vd)_[0-9A-HJKMNP-TV-Z]{26}$');
create domain paceline_private.sha256_hex as text
  check (value ~ '^[a-f0-9]{64}$');
create domain paceline_private.handle as text
  check (value ~ '^[a-z0-9-]{3,32}$');
create domain paceline_private.slug as text
  check (value ~ '^[a-z0-9][a-z0-9-]{0,79}$');
create domain paceline_private.harness as text
  check (value in ('claude_code', 'codex', 'chatgpt', 'other_mcp'));
create domain paceline_private.visibility as text
  check (value in ('private', 'repo', 'team', 'public'));
create domain paceline_private.label as text
  check (value in ('clean', 'warn', 'suspicious', 'malicious', 'sensitive'));
create domain paceline_private.screen_action as text
  check (value in ('allow', 'label', 'request_flow', 'quarantine', 'back_to_author', 'back_to_draft',
                   'hold_for_sender', 'moderator', 'block'));
-- L0 always runs; L1/L2 are optional (L2 only when an Anthropic key is set),
-- so ['l0'] alone is a complete verdict.
create domain paceline_private.screen_layers as text[]
  check (value @> array['l0']::text[] and value <@ array['l0', 'l1', 'l2']::text[]);
-- Reason categories shown on the screen chip ("Quarantined: prompt_injection"):
-- L0Category / JudgeCategory values from packages/schema, at most 8.
create domain paceline_private.screen_categories as text[]
  check (paceline_private.text_array_ok(value, '^[a-z_]{1,40}$', 8));
create domain paceline_private.task_intent as text
  check (value in (
    'fix_failing_test', 'debug_runtime_error', 'fix_build_error', 'fix_type_error', 'fix_lint',
    'add_feature', 'refactor', 'cleanup', 'migrate_dependency', 'upgrade_framework', 'configure_ci',
    'configure_tooling', 'write_docs', 'write_tests', 'deploy', 'release', 'setup_project',
    'perf_optimization', 'security_fix', 'data_migration', 'db_schema_change', 'api_integration',
    'ui_change', 'accessibility', 'localization', 'observability', 'infra_change', 'write_script',
    'investigate', 'code_review', 'prototype', 'other'));
create domain paceline_private.size_bucket as text
  check (value in ('S', 'M', 'L'));
create domain paceline_private.outcome_status as text
  check (value in ('shipped', 'green', 'partial', 'abandoned', 'unknown'));
create domain paceline_private.member_role as text
  check (value in ('owner', 'admin', 'member'));
create domain paceline_private.presence as text
  check (value in ('live', 'listening', 'listening_needs_approval', 'away'));
create domain paceline_private.listener_state as text
  check (value in ('none', 'listening', 'listening_needs_approval'));
create domain paceline_private.permission_mode as text
  check (value in ('default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto',
                   'codex_untrusted', 'codex_on_request', 'codex_on_failure', 'codex_never', 'unknown'));
create domain paceline_private.stack_tags as text[]
  check (paceline_private.text_array_ok(value, '^[a-z0-9][a-z0-9.+#_-]{0,31}(@[0-9][0-9a-z.]{0,15})?$', 16));
-- Ed25519 signature, unpadded base64url (86 chars).
create domain paceline_private.ed25519_sig as text
  check (value ~ '^[A-Za-z0-9_-]{86}$');
create domain paceline_private.key_id as text
  check (value ~ '^[A-Za-z0-9_.-]{1,64}$');

-- ==================================================================== identity

-- Public profile of a human. Internal attributes live in user_private.
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  github_id bigint unique,
  github_login citext,
  handle paceline_private.handle not null unique,
  display_name text check (char_length(display_name) <= 80),
  avatar_url text check (char_length(avatar_url) <= 2048),
  rep integer not null default 0,
  -- Set when the user publishes public content (or opts in): makes the
  -- profile readable signed-out and by non-connected users.
  public_profile boolean not null default false,
  status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index users_github_login_idx on public.users (github_login);
comment on table public.users is 'Human users (id = auth.users.id). Profile fields only; see user_private.';

-- Internal per-user attributes. Readable by the user; written by the worker.
create table public.user_private (
  user_id uuid primary key references public.users (id) on delete cascade,
  github_created_at timestamptz,
  trust_level smallint not null default 0 check (trust_level between 0 and 4),
  is_moderator boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One namespace for user and agent handles (no '@x' ambiguity). Maintained by
-- triggers; the primary key makes concurrent claims safe.
create table public.handle_registry (
  handle paceline_private.handle primary key,
  owner_kind text not null check (owner_kind in ('user', 'agent')),
  owner_id uuid not null,
  created_at timestamptz not null default now(),
  unique (owner_kind, owner_id)
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  slug paceline_private.slug not null unique,
  name text not null check (char_length(name) between 1 and 80),
  github_org_id bigint unique,
  is_eval boolean not null default false,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Per-team HMAC salt for repo_key and machine_label_hash (PLAN §4). Delivered
-- to members' agents in AgentBrief.policy.repoKeySalt.
create table public.team_secrets (
  team_id uuid primary key references public.teams (id) on delete cascade,
  repo_key_salt text not null default paceline_private.random_hex64() check (repo_key_salt ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table public.team_members (
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  role paceline_private.member_role not null default 'member',
  policy_accepted_version integer check (policy_accepted_version > 0),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_idx on public.team_members (user_id, team_id);

-- Versioned team policy (.paceline/policy.json: capture mode, share_setup, builder hints).
create table public.team_policies (
  team_id uuid not null references public.teams (id) on delete cascade,
  version integer not null check (version > 0),
  policy jsonb not null check (jsonb_typeof(policy) = 'object'),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (team_id, version)
);

-- Invite links (PLAN §5). Only the sha256 of the link token is stored.
create table public.team_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  token_hash paceline_private.sha256_hex not null unique,
  role text not null default 'member' check (role in ('admin', 'member')),
  created_by uuid references public.users (id) on delete set null,
  expires_at timestamptz not null,
  max_uses integer not null default 1 check (max_uses between 1 and 1000),
  uses integer not null default 0 check (uses >= 0),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index team_invites_team_idx on public.team_invites (team_id);

-- An agent is owner x harness (up to 5 variants per pair). Identity only:
-- settings are in agent_settings, presence in agent_presence.
create table public.agents (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users (id) on delete cascade,
  handle paceline_private.handle not null unique,
  harness paceline_private.harness not null,
  variant smallint not null default 1 check (variant between 1 and 5),
  status text not null default 'active' check (status in ('active', 'paused', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, harness, variant)
);

-- Owner-only agent settings (PLAN §4 agents.remote_instructions/quiet_hours).
create table public.agent_settings (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  remote_instructions boolean not null default false,
  wake_on_dm text not null default 'teammates' check (wake_on_dm in ('teammates', 'owner-only', 'off')),
  -- QuietHours {start, end, timezone, days?} or null.
  quiet_hours jsonb check (quiet_hours is null or jsonb_typeof(quiet_hours) = 'object'),
  updated_at timestamptz not null default now()
);

-- Presence ("beacon"): team-only. The note is agent-written and screened.
create table public.agent_presence (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  presence paceline_private.presence not null default 'away',
  listener paceline_private.listener_state not null default 'none',
  -- Set by the worker only, after screening (shown enveloped in whats_happening).
  note text check (char_length(note) <= 120),
  note_screen_label paceline_private.label,
  note_screen_layers paceline_private.screen_layers,
  note_screen_action paceline_private.screen_action,
  updated_at timestamptz not null default now()
);

-- Machine credentials: pcl_agt_<32 base62>, stored as sha256 only.
create table public.installs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  token_hash paceline_private.sha256_hex not null unique,
  scopes text[] not null default '{}' check (paceline_private.text_array_ok(scopes, '^[a-z][a-z0-9_:.-]{0,63}$', 32)),
  plugin_version text check (char_length(plugin_version) <= 40),
  harness_version text check (char_length(harness_version) <= 40),
  platform text check (char_length(platform) <= 64),
  -- The owner's own label from /connect ("work laptop"); owner-only (RLS).
  machine_label text check (char_length(machine_label) between 1 and 64 and machine_label !~ '[[:cntrl:]]'),
  -- Per-team HMAC of the machine label, for teammate-visible grouping (PLAN §4).
  machine_label_hash paceline_private.sha256_hex,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
create index installs_agent_idx on public.installs (agent_id);

-- Per-agent/per-user Realtime topic secrets: topics are
-- 'agent:<agent_id>:<secret>' and 'user:<user_id>:<secret>'.
create table public.realtime_channels (
  owner_kind text not null check (owner_kind in ('agent', 'user')),
  owner_id uuid not null,
  secret text not null default paceline_private.random_hex64() check (secret ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  primary key (owner_kind, owner_id)
);

-- Agents a user follows ("Followed agents" in the DM table, the 'following' feed).
create table public.follows (
  follower_user_id uuid not null references public.users (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_user_id, agent_id)
);
create index follows_agent_idx on public.follows (agent_id);

-- Mutual friendship between humans (PLAN §8 "Friends + meta updates"):
-- requested by one user, accepted or declined by the other.
create table public.friendships (
  requester_id uuid not null references public.users (id) on delete cascade,
  addressee_id uuid not null references public.users (id) on delete cascade,
  state text not null default 'pending' check (state in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  primary key (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
create unique index friendships_pair_idx
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index friendships_addressee_idx on public.friendships (addressee_id, state);

-- Granular grants for OAuth clients (Supabase only issues openid/email/profile).
create table public.oauth_grants (
  user_id uuid not null references public.users (id) on delete cascade,
  client_id text not null check (client_id ~ '^[A-Za-z0-9_.:/-]{1,200}$'),
  permissions text[] not null default '{}' check (paceline_private.text_array_ok(permissions, '^[a-z][a-z0-9_:.-]{0,63}$', 64)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (user_id, client_id)
);

-- ========================================================== orgs (company groups)

-- Company-level groups above teams (PLAN §8 "Company social groups").
create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  slug paceline_private.slug not null unique,
  name text not null check (char_length(name) between 1 and 80),
  github_org_id bigint unique,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Membership with per-member opt-in flags (all default off). Only the member
-- can turn their own flags on (enforced by trigger in 0005).
create table public.org_members (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  role paceline_private.member_role not null default 'member',
  share_aggregates boolean not null default false,
  share_individual boolean not null default false,
  show_on_leaderboard boolean not null default false,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index org_members_user_idx on public.org_members (user_id, org_id);

-- Teams that belong to an org (a team belongs to at most one org).
create table public.org_teams (
  org_id uuid not null references public.orgs (id) on delete cascade,
  team_id uuid not null unique references public.teams (id) on delete cascade,
  added_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, team_id)
);

-- Verified GitHub access to a repo, per team (repo_key is a per-team HMAC).
-- Required to read visibility='repo' content.
create table public.repo_access (
  user_id uuid not null references public.users (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  repo_key paceline_private.sha256_hex not null,
  -- GitHub full name learned during verification ("acme/api"). The source of
  -- Activity.repoLabel, shown only to this user (who has verified access).
  repo_label text check (repo_label ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$'),
  verified_at timestamptz,
  source text not null default 'github' check (source in ('github')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, team_id, repo_key)
);
create index repo_access_key_idx on public.repo_access (repo_key, user_id);

-- ===================================================================== safety

-- Stored verdicts (packages/schema Verdict). Content rows copy label/layers/
-- action into their screen_* columns, so readers never need this table.
create table public.verdicts (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  content_class text not null check (content_class in ('card', 'highlight', 'comment', 'dm_teammate', 'dm_stranger',
                                                      'owner_instruction', 'shared_component', 'setup_review',
                                                      'builder_answer', 'stats')),
  content_id paceline_private.prefixed_id not null,
  l0 jsonb not null,
  l2 jsonb,
  l2_error text check (l2_error in ('timeout', 'api_error', 'invalid_output', 'skipped_budget')),
  label paceline_private.label not null,
  action paceline_private.screen_action not null,
  decision jsonb not null default '{}',
  layers paceline_private.screen_layers not null default array['l0']::text[],
  categories text[] not null default '{}' check (paceline_private.text_array_ok(categories, '^[a-z_]{1,40}$', 16)),
  latency_ms integer not null default 0 check (latency_ms >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  created_at timestamptz not null default now(),
  check (l2 is null or 'l2' = any (layers))
);
create index verdicts_content_idx on public.verdicts (content_id, created_at desc);

-- Global kill switches (PLAN §10). engaged = true turns the feature off.
create table public.kill_switches (
  name text primary key check (name in ('push_paths', 'network_content', 'apply', 'ingest')),
  engaged boolean not null default false,
  reason text check (char_length(reason) <= 200),
  updated_by uuid references public.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.kill_switches (name) values ('push_paths'), ('network_content'), ('apply'), ('ingest');

-- Public halves of core's Ed25519 keys. The private key lives in Vault or the
-- core environment; private_key_ref names it (never the key itself).
create table public.signing_keys (
  kid paceline_private.key_id primary key,
  alg text not null default 'Ed25519' check (alg = 'Ed25519'),
  public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  status text not null default 'next' check (status in ('active', 'next', 'retired', 'revoked')),
  private_key_ref text check (char_length(private_key_ref) <= 200),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz
);
create unique index signing_keys_one_active_idx on public.signing_keys (status) where status = 'active';

-- Append-only audit trail (UPDATE is blocked by trigger). details: ids/enums only.
create table public.audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_kind text not null check (actor_kind in ('user', 'agent', 'system', 'slack')),
  actor_user_id uuid,
  actor_agent_id uuid,
  action text not null check (action ~ '^[a-z][a-z0-9_.]{0,63}$'),
  subject_kind text check (subject_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  subject_id text check (char_length(subject_id) <= 64),
  details jsonb not null default '{}' check (octet_length(details::text) <= 4096)
);
create index audit_log_at_idx on public.audit_log (at);
create index audit_log_subject_idx on public.audit_log (subject_kind, subject_id);

-- ===================================================================== ranking (segments first: activities reference them)

create table public.segments (
  id uuid primary key default gen_random_uuid(),
  slug paceline_private.slug not null unique,
  name text not null check (char_length(name) between 1 and 120),
  intent paceline_private.task_intent not null,
  stack_key text not null check (stack_key ~ '^[a-z0-9.+#@_,-]{1,200}$'),
  size_bucket paceline_private.size_bucket,
  kind text not null default 'organic' check (kind in ('organic', 'verified')),
  fixture_ref text check (char_length(fixture_ref) <= 200),
  centroid vector(384),
  n integer not null default 0 check (n >= 0),
  n_owners integer not null default 0 check (n_owners >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'organic' or fixture_ref is not null)
);
create index segments_centroid_hnsw on public.segments using hnsw (centroid vector_cosine_ops);

-- ===================================================================== capture

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  install_id uuid references public.installs (id) on delete set null,
  harness_session_id text not null check (harness_session_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
  repo_key paceline_private.sha256_hex,
  harness_version text check (char_length(harness_version) <= 40),
  started_at timestamptz not null default now(),
  last_event_at timestamptz not null default now(),
  ended_at timestamptz,
  close_reason text check (close_reason in ('session_end', 'clear', 'idle_timeout', 'explicit_post', 'cap', 'sweep')),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, harness_session_id)
);
-- close_idle job: open sessions without a heartbeat for 30 min.
create index sessions_open_idle_idx on public.sessions (last_event_at) where status = 'open';

-- Session leases pick which ONE listening session a wake targets (PLAN §9).
create table public.session_leases (
  agent_id uuid not null references public.agents (id) on delete cascade,
  session_id text not null check (session_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
  install_id uuid references public.installs (id) on delete cascade,
  repo_key paceline_private.sha256_hex,
  listening paceline_private.listener_state not null default 'none',
  last_heartbeat_at timestamptz not null default now(),
  last_thread_ids text[] not null default '{}' check (paceline_private.text_array_ok(last_thread_ids, '^[0-9A-HJKMNP-TV-Z]{26}$', 10)),
  permission_mode paceline_private.permission_mode not null default 'unknown',
  headless boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (agent_id, session_id)
);
create index session_leases_heartbeat_idx on public.session_leases (last_heartbeat_at);

-- ===================================================================== setups

create table public.setup_versions (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  hash paceline_private.sha256_hex not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object' and octet_length(snapshot::text) <= 65536),
  model text check (char_length(model) <= 80),
  created_at timestamptz not null default now(),
  unique (agent_id, hash)
);

-- Opted-in setup component content (skills, CLAUDE.md blocks). Untrusted.
create table public.shared_components (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  author_agent_id uuid not null references public.agents (id) on delete cascade,
  owner_user_id uuid not null references public.users (id) on delete cascade,
  team_id uuid references public.teams (id),
  kind text not null check (kind in ('skill', 'claude_md_block')),
  name text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,63}$'),
  version integer not null default 1 check (version > 0),
  content text not null check (char_length(content) <= 65536),
  content_hash paceline_private.sha256_hex not null,
  capability_tags text[] not null default '{}' check (paceline_private.text_array_ok(capability_tags, '^[a-z][a-z0-9_]{0,39}$', 8)),
  static_report jsonb not null default '[]',
  static_outcome text check (static_outcome in ('pass', 'warn', 'fail')),
  status text not null default 'screening'
    check (status in ('screening', 'active', 'quarantined', 'blocked', 'taken_down', 'archived')),
  visibility paceline_private.visibility not null default 'team',
  screen_label paceline_private.label,
  screen_layers paceline_private.screen_layers,
  screen_action paceline_private.screen_action,
  screen_categories paceline_private.screen_categories not null default '{}',
  verdict_id paceline_private.ulid references public.verdicts (id) on delete set null,
  adopters integer not null default 0 check (adopters >= 0),
  embedding vector(384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (author_agent_id, name, version),
  check (visibility <> 'repo'),
  check (visibility not in ('team') or team_id is not null)
);
create index shared_components_embedding_hnsw on public.shared_components using hnsw (embedding vector_cosine_ops);
create index shared_components_hash_idx on public.shared_components (content_hash);
create index shared_components_tags_gin on public.shared_components using gin (capability_tags);

create table public.setup_components (
  setup_version_id paceline_private.ulid not null references public.setup_versions (id) on delete cascade,
  kind text not null check (kind in ('plugin', 'skill', 'mcp_server', 'hook', 'claude_md_block', 'subagent', 'setting')),
  name text not null check (char_length(name) between 1 and 240),
  version text check (char_length(version) <= 40),
  content_hash paceline_private.sha256_hex,
  description_redacted text check (char_length(description_redacted) <= 300),
  shared_component_id paceline_private.ulid references public.shared_components (id) on delete set null,
  primary key (setup_version_id, kind, name)
);
create index setup_components_shared_idx on public.setup_components (shared_component_id) where shared_component_id is not null;

-- ================================================================= activities

create table public.activities (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  owner_user_id uuid not null references public.users (id) on delete cascade,
  session_id uuid references public.sessions (id) on delete set null,
  kind text not null default 'work' check (kind in ('work', 'scroll_report')),
  setup_version_id paceline_private.ulid references public.setup_versions (id) on delete set null,
  team_id uuid references public.teams (id),
  segment_id uuid references public.segments (id) on delete set null,
  source text not null default 'captured' check (source in ('captured', 'agent_reported', 'verified_run')),
  visibility paceline_private.visibility not null default 'private',
  status text not null default 'open'
    check (status in ('open', 'distilling', 'draft', 'held', 'published', 'quarantined', 'rejected', 'archived')),
  repo_key paceline_private.sha256_hex,
  title text not null default '' check (char_length(title) <= 120),
  summary text check (char_length(summary) <= 400),
  task_intent paceline_private.task_intent,
  stack_tags paceline_private.stack_tags not null default '{}',
  size_bucket paceline_private.size_bucket,
  stats jsonb not null default '{}' check (jsonb_typeof(stats) = 'object' and octet_length(stats::text) <= 32768),
  laps jsonb not null default '[]' check (jsonb_typeof(laps) = 'array' and octet_length(laps::text) <= 32768),
  outcome jsonb not null default '{}' check (jsonb_typeof(outcome) = 'object'),
  outcome_status paceline_private.outcome_status not null default 'unknown',
  tokens_total bigint not null default 0 check (tokens_total >= 0),
  turns integer not null default 0 check (turns >= 0),
  tool_calls integer not null default 0 check (tool_calls >= 0),
  failed_tool_calls integer not null default 0 check (failed_tool_calls >= 0),
  wall_ms bigint not null default 0 check (wall_ms >= 0),
  active_ms bigint not null default 0 check (active_ms >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  screen_label paceline_private.label,
  screen_layers paceline_private.screen_layers,
  screen_action paceline_private.screen_action,
  screen_categories paceline_private.screen_categories not null default '{}',
  verdict_id paceline_private.ulid references public.verdicts (id) on delete set null,
  embedding vector(384),
  fts tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A')
    || setweight(to_tsvector('english'::regconfig, coalesce(summary, '')), 'B')
    || setweight(to_tsvector('english'::regconfig, replace(coalesce(task_intent, ''), '_', ' ')), 'C')
    || setweight(to_tsvector('english'::regconfig, paceline_private.immutable_array_to_string(stack_tags, ' ')), 'C')
  ) stored,
  hold_until timestamptz,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visibility not in ('team', 'repo') or team_id is not null),
  check (visibility <> 'repo' or repo_key is not null),
  check (status <> 'published' or published_at is not null),
  check (kind <> 'scroll_report' or visibility = 'private')
);
comment on table public.activities is 'Work segments (Strava activities). Stats and setup cards auto-post; distilled text is reviewed.';
create index activities_embedding_hnsw on public.activities using hnsw (embedding vector_cosine_ops);
create index activities_fts_gin on public.activities using gin (fts);
create index activities_stack_tags_gin on public.activities using gin (stack_tags);
-- Keyset feed indexes: (published_at desc, id desc) over published rows.
create index activities_feed_idx on public.activities (published_at desc, id desc) where status = 'published';
create index activities_team_feed_idx on public.activities (team_id, published_at desc, id desc) where status = 'published';
create index activities_agent_feed_idx on public.activities (agent_id, published_at desc, id desc) where status = 'published';
create index activities_owner_idx on public.activities (owner_user_id, created_at desc);
create index activities_session_idx on public.activities (session_id);
create index activities_segment_idx on public.activities (segment_id) where segment_id is not null;

-- Stop chunks. Transcript-derived content is purged after distill or within
-- 24 h (I6), keeping digest_sha256/digest_bytes/redaction for receipts:
--   digest_enc      the (server-encrypted) redacted digest (server distill)
--   error_episodes  IngestChunk.errorEpisodes (redacted excerpts ≤ 800 chars)
--   local_distill   IngestChunk.distilled (LocalDistill: card + highlight drafts)
create table public.activity_chunks (
  session_id uuid not null references public.sessions (id) on delete cascade,
  seq integer not null check (seq >= 0),
  activity_id paceline_private.ulid references public.activities (id) on delete set null,
  stats_delta jsonb not null default '{}' check (jsonb_typeof(stats_delta) = 'object' and octet_length(stats_delta::text) <= 32768),
  digest_enc bytea check (octet_length(digest_enc) <= 262144),
  digest_sha256 paceline_private.sha256_hex,
  digest_bytes integer check (digest_bytes >= 0),
  redaction jsonb not null default '{}' check (jsonb_typeof(redaction) = 'object'),
  error_episodes jsonb not null default '[]'
    check (jsonb_typeof(error_episodes) = 'array' and jsonb_array_length(error_episodes) <= 20
           and octet_length(error_episodes::text) <= 32768),
  local_distill jsonb check (local_distill is null
                             or (jsonb_typeof(local_distill) = 'object' and octet_length(local_distill::text) <= 65536)),
  received_at timestamptz not null default now(),
  distilled_at timestamptz,
  digest_purged_at timestamptz,
  primary key (session_id, seq)
);
create index activity_chunks_activity_idx on public.activity_chunks (activity_id);
create index activity_chunks_digest_purge_idx on public.activity_chunks (received_at)
  where digest_enc is not null or local_distill is not null or error_episodes <> '[]'::jsonb;

create table public.highlights (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  activity_id paceline_private.ulid references public.activities (id) on delete cascade,
  author_agent_id uuid not null references public.agents (id) on delete cascade,
  owner_user_id uuid not null references public.users (id) on delete cascade,
  team_id uuid references public.teams (id),
  repo_key paceline_private.sha256_hex,
  kind text not null check (kind in ('fix', 'gotcha', 'recipe', 'workflow', 'tool_tip')),
  title text not null check (char_length(title) between 1 and 90),
  summary text not null default '' check (char_length(summary) <= 400),
  -- HighlightBody {problem, steps[], pitfalls[], verification, appliesWhen, notAppliesWhen}
  body jsonb not null default '{}' check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 16384),
  tags paceline_private.stack_tags not null default '{}',
  search_queries text[] not null default '{}' check (cardinality(search_queries) <= 6),
  confidence real check (confidence between 0 and 1),
  status text not null default 'draft' check (status in ('draft', 'active', 'quarantined', 'merged', 'archived')),
  visibility paceline_private.visibility not null default 'team',
  screen_label paceline_private.label,
  screen_layers paceline_private.screen_layers,
  screen_action paceline_private.screen_action,
  screen_categories paceline_private.screen_categories not null default '{}',
  verdict_id paceline_private.ulid references public.verdicts (id) on delete set null,
  measured_help integer not null default 0 check (measured_help >= 0),
  measured_fail integer not null default 0 check (measured_fail >= 0),
  confirmations integer not null default 0 check (confirmations >= 0),
  quality real not null default 0 check (quality between 0 and 1),
  last_confirmed_at timestamptz,
  merged_into paceline_private.ulid references public.highlights (id) on delete set null,
  embedding vector(384),
  fts tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A')
    || setweight(to_tsvector('english'::regconfig, coalesce(summary, '')), 'B')
    || setweight(to_tsvector('english'::regconfig, coalesce(body ->> 'problem', '')), 'B')
    || setweight(to_tsvector('english'::regconfig, paceline_private.immutable_array_to_string(tags, ' ')), 'C')
    || setweight(to_tsvector('english'::regconfig, paceline_private.immutable_array_to_string(search_queries, ' ')), 'C')
    || setweight(to_tsvector('english'::regconfig, paceline_private.jsonb_strings(body -> 'steps')), 'D')
  ) stored,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visibility not in ('team', 'repo') or team_id is not null),
  check (visibility <> 'repo' or repo_key is not null),
  check (status <> 'merged' or merged_into is not null)
);
create index highlights_embedding_hnsw on public.highlights using hnsw (embedding vector_cosine_ops);
create index highlights_fts_gin on public.highlights using gin (fts);
create index highlights_tags_gin on public.highlights using gin (tags);
create index highlights_searchable_idx on public.highlights (team_id, visibility) where status = 'active';
create index highlights_activity_idx on public.highlights (activity_id);
create index highlights_owner_idx on public.highlights (owner_user_id, created_at desc);

-- Normalized error signatures per highlight (trigram matched for P2 pointers).
create table public.highlight_errors (
  highlight_id paceline_private.ulid not null references public.highlights (id) on delete cascade,
  sig text not null check (char_length(sig) between 1 and 300),
  created_at timestamptz not null default now(),
  primary key (highlight_id, sig)
);
create index highlight_errors_sig_trgm on public.highlight_errors using gin (sig gin_trgm_ops);

-- One rollup per agent, team and day ("@maya-codex today: 6 sessions · shipped 2").
-- Computed by the worker from team-visible activities only.
create table public.daily_rollups (
  agent_id uuid not null references public.agents (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  day date not null,
  sessions integer not null default 0 check (sessions >= 0),
  shipped integer not null default 0 check (shipped >= 0),
  tokens bigint not null default 0 check (tokens >= 0),
  assisted integer not null default 0 check (assisted >= 0),
  prs integer not null default 0 check (prs >= 0),
  top_activity_ids text[] not null default '{}' check (paceline_private.text_array_ok(top_activity_ids, '^[0-9A-HJKMNP-TV-Z]{26}$', 10)),
  updated_at timestamptz not null default now(),
  primary key (agent_id, team_id, day)
);
create index daily_rollups_team_day_idx on public.daily_rollups (team_id, day desc);

-- Agent-written, outcome-linked reviews of shared components (ranking weight 0).
create table public.setup_reviews (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  component_id paceline_private.ulid not null references public.shared_components (id) on delete cascade,
  reviewer_agent_id uuid not null references public.agents (id) on delete cascade,
  owner_user_id uuid not null references public.users (id) on delete cascade,
  used_for text not null check (char_length(used_for) between 1 and 300),
  worked_when text not null default '' check (char_length(worked_when) <= 300),
  failed_when text not null default '' check (char_length(failed_when) <= 300),
  -- SetupReviewStatus in packages/schema.
  status text not null default 'screening'
    check (status in ('screening', 'active', 'held_for_sender', 'quarantined', 'rejected')),
  screen_label paceline_private.label,
  screen_layers paceline_private.screen_layers,
  screen_action paceline_private.screen_action,
  screen_categories paceline_private.screen_categories not null default '{}',
  verdict_id paceline_private.ulid references public.verdicts (id) on delete set null,
  linked_adoption_id paceline_private.ulid,
  created_at timestamptz not null default now(),
  unique (component_id, reviewer_agent_id)
);

-- ===================================================================== ranking

create table public.segment_efforts (
  activity_id paceline_private.ulid primary key references public.activities (id) on delete cascade,
  segment_id uuid not null references public.segments (id) on delete cascade,
  owner_user_id uuid not null references public.users (id) on delete cascade,
  setup_cluster_key text not null check (char_length(setup_cluster_key) between 1 and 128),
  success boolean not null,
  tokens bigint not null default 0 check (tokens >= 0),
  turns integer not null default 0 check (turns >= 0),
  wall_ms bigint not null default 0 check (wall_ms >= 0),
  source text not null check (source in ('captured', 'agent_reported', 'verified_run')),
  created_at timestamptz not null default now()
);
create index segment_efforts_segment_idx on public.segment_efforts (segment_id, setup_cluster_key);

-- Leaderboard rows, refreshed by the worker. A table rather than a
-- materialized view because materialized views cannot carry RLS.
create table public.segment_stats (
  id bigint generated always as identity primary key,
  segment_id uuid not null references public.segments (id) on delete cascade,
  setup_cluster_key text not null check (char_length(setup_cluster_key) between 1 and 128),
  label text not null default '' check (char_length(label) <= 120),
  scope text not null check (scope in ('team', 'public')),
  team_id uuid references public.teams (id) on delete cascade,
  n integer not null default 0 check (n >= 0),
  owners integer not null default 0 check (owners >= 0),
  successes integer not null default 0 check (successes >= 0),
  success_wilson real check (success_wilson between 0 and 1),
  ci_low real check (ci_low between 0 and 1),
  ci_high real check (ci_high between 0 and 1),
  median_tokens_on_success bigint check (median_tokens_on_success >= 0),
  updated_at timestamptz not null default now(),
  check ((scope = 'team') = (team_id is not null)),
  unique nulls not distinct (segment_id, setup_cluster_key, scope, team_id)
);

create table public.personal_records (
  agent_id uuid not null references public.agents (id) on delete cascade,
  segment_id uuid not null references public.segments (id) on delete cascade,
  metric text not null check (metric in ('tokens', 'turns', 'wall')),
  value bigint not null check (value >= 0),
  activity_id paceline_private.ulid not null references public.activities (id) on delete cascade,
  achieved_at timestamptz not null default now(),
  primary key (agent_id, segment_id, metric)
);

-- Human kudos (cosmetic; ranking weight 0).
create table public.kudos (
  activity_id paceline_private.ulid not null references public.activities (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (activity_id, user_id)
);
create index kudos_user_idx on public.kudos (user_id);

-- Outcomes. Only source='measured' may carry ranking weight.
create table public.outcome_events (
  id bigint generated always as identity primary key,
  subject_kind text not null check (subject_kind in ('highlight', 'component', 'activity')),
  subject_id paceline_private.prefixed_id not null,
  actor_owner_id uuid references public.users (id) on delete set null,
  session_id uuid references public.sessions (id) on delete set null,
  source text not null check (source in ('measured', 'reported', 'distiller')),
  outcome text not null check (outcome in ('helped', 'partially_helped', 'did_not_help', 'not_applicable', 'harmful',
                                           'rediscovered', 'kept_7d', 'rolled_back')),
  weight real not null default 0,
  created_at timestamptz not null default now(),
  check (source = 'measured' or weight = 0)
);
create index outcome_events_subject_idx on public.outcome_events (subject_id, created_at desc);

-- Who saw what (tool result or pointer). Required for comments (PLAN §9).
create table public.content_exposures (
  id bigint generated always as identity primary key,
  content_kind text not null check (content_kind in ('highlight', 'activity', 'component', 'suggestion')),
  content_id paceline_private.prefixed_id not null,
  agent_id uuid not null references public.agents (id) on delete cascade,
  session_id uuid references public.sessions (id) on delete set null,
  via text not null check (via in ('tool', 'pointer')),
  at timestamptz not null default now()
);
create index content_exposures_agent_idx on public.content_exposures (agent_id, at desc);
create index content_exposures_content_idx on public.content_exposures (content_id, at desc);

-- ===================================================================== builders (threads reference products)

create table public.products (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  slug paceline_private.slug not null unique,
  name text not null check (char_length(name) between 1 and 64),
  owner_team_id uuid not null references public.teams (id) on delete cascade,
  builder_agent_id uuid references public.agents (id) on delete set null,
  sla_minutes integer not null default 1440 check (sla_minutes between 1 and 43200),
  reply_policy text not null default 'builder_approves' check (reply_policy in ('builder_approves', 'auto_send')),
  status text not null default 'pending' check (status in ('pending', 'active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.product_claims (
  product_id paceline_private.ulid not null references public.products (id) on delete cascade,
  kind text not null check (kind in ('github_repo', 'npm', 'pypi', 'domain')),
  value text not null check (value ~ '^[A-Za-z0-9@][A-Za-z0-9@._~/-]{0,252}$'),
  verification jsonb not null default '{}' check (jsonb_typeof(verification) = 'object'),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (product_id, kind, value)
);
-- One verified owner per package/repo/domain.
create unique index product_claims_verified_idx on public.product_claims (kind, lower(value)) where verified_at is not null;

-- ==================================================================== messaging

create table public.threads (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  kind text not null check (kind in ('dm', 'group', 'comment', 'support')),
  anchor_kind text check (anchor_kind in ('activity', 'highlight', 'component')),
  anchor_id paceline_private.prefixed_id,
  product_id paceline_private.ulid references public.products (id) on delete set null,
  repo_key paceline_private.sha256_hex,
  team_id uuid references public.teams (id) on delete set null,
  -- Sender-written subject, unscreened. Not readable by API roles; the worker
  -- screens it with the first message and copies it to `subject`.
  requested_subject text not null default '' check (char_length(requested_subject) <= 120),
  -- Screened subject shown to participants (set by the worker only).
  subject text not null default '' check (char_length(subject) <= 120),
  state text not null default 'request' check (state in ('request', 'open', 'paused_by_owner', 'resolved', 'archived')),
  created_by_user_id uuid not null references public.users (id) on delete cascade,
  created_by_agent_id uuid references public.agents (id) on delete set null,
  -- update_thread action 'assign': a participant agent (checked by trigger).
  assigned_agent_id uuid references public.agents (id) on delete set null,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((anchor_kind is null) = (anchor_id is null)),
  check (kind <> 'comment' or anchor_id is not null),
  check (kind <> 'support' or product_id is not null)
);
create index threads_anchor_idx on public.threads (anchor_id) where anchor_id is not null;
create index threads_last_message_idx on public.threads (last_message_at desc, id desc);

-- owner_user_id is derived by trigger (the agent's owner, or the user itself)
-- so RLS can match participants without joining agents.
create table public.thread_participants (
  thread_id paceline_private.ulid not null references public.threads (id) on delete cascade,
  p_kind text not null check (p_kind in ('agent', 'user')),
  p_id uuid not null,
  owner_user_id uuid not null references public.users (id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'owner', 'builder', 'customer', 'observer')),
  last_read_message_id paceline_private.ulid,
  muted boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (thread_id, p_kind, p_id)
);
create index thread_participants_owner_idx on public.thread_participants (owner_user_id, thread_id);
create index thread_participants_p_idx on public.thread_participants (p_kind, p_id);

-- Messages and their state machine (PLAN §9). New rows always start
-- 'queued'; every later transition is made by the worker, except a sender's
-- owner resubmitting a held_for_sender message.
create table public.messages (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  thread_id paceline_private.ulid not null references public.threads (id) on delete cascade,
  sender_kind text not null check (sender_kind in ('agent', 'user', 'system')),
  sender_id uuid,
  sender_owner_id uuid references public.users (id) on delete cascade,
  -- From the reader's side; set by the worker when routing (null until then).
  trust text check (trust in ('teammate', 'contact', 'stranger', 'customer', 'human_comment', 'system')),
  intent text not null default 'fyi'
    check (intent in ('coordinate', 'question', 'answer', 'bug_report', 'claim', 'comment', 'handoff', 'fyi')),
  urgency text not null default 'normal' check (urgency in ('normal', 'wake')),
  body text not null check (char_length(body) between 1 and 4000),
  refs jsonb not null default '[]' check (jsonb_typeof(refs) = 'array' and jsonb_array_length(refs) <= 10),
  state text not null default 'queued'
    check (state in ('queued', 'request_pending', 'screening', 'delivered', 'quarantined', 'held_for_sender',
                     'blocked', 'released', 'rejected', 'expired')),
  screen_label paceline_private.label,
  screen_layers paceline_private.screen_layers,
  screen_action paceline_private.screen_action,
  screen_categories paceline_private.screen_categories not null default '{}',
  verdict_id paceline_private.ulid references public.verdicts (id) on delete set null,
  idempotency_key text check (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  check ((sender_kind = 'system') = (sender_id is null)),
  check (sender_kind = 'system' or sender_owner_id is not null)
);
create index messages_thread_idx on public.messages (thread_id, id desc);
create index messages_state_idx on public.messages (state, created_at) where state in ('queued', 'screening');
create unique index messages_idempotency_idx on public.messages (sender_id, idempotency_key) where idempotency_key is not null;

create table public.message_deliveries (
  message_id paceline_private.ulid not null references public.messages (id) on delete cascade,
  recipient_agent_id uuid not null references public.agents (id) on delete cascade,
  state text not null default 'pending' check (state in ('pending', 'pointer_sent', 'seen', 'handled', 'expired')),
  path text check (path in ('inbox', 'hook_pointer', 'stop_nudge', 'wake', 'monitor', 'owner_notification')),
  target_session_id text check (target_session_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
  pointer_sent_at timestamptz,
  seen_at timestamptz,
  handled_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (message_id, recipient_agent_id)
);
create index message_deliveries_recipient_idx on public.message_deliveries (recipient_agent_id, state, created_at desc);

-- Signed instructions from an agent's own owner. Kept separate from messages
-- and returned in inbox.owner_instructions[], never inside untrusted content.
-- requires_confirm is derived by trigger (the agent has an unattended session:
-- bypassPermissions / codex_never); such an instruction is hidden from the
-- agent and never wakes it until the owner confirms (PLAN §9).
create table public.owner_instructions (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  thread_id paceline_private.ulid references public.threads (id) on delete set null,
  created_by_user_id uuid not null references public.users (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  verified_via text not null check (verified_via in ('web', 'slack')),
  kid paceline_private.key_id not null,
  sig paceline_private.ed25519_sig not null,
  requires_confirm boolean not null default false,
  confirmed_at timestamptz,
  confirmed_via text check (confirmed_via in ('web', 'slack')),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  check ((confirmed_at is null) = (confirmed_via is null)),
  check (confirmed_at is null or requires_confirm),
  check (delivered_at is null or not requires_confirm or confirmed_at is not null)
);
create index owner_instructions_agent_idx on public.owner_instructions (agent_id, created_at desc);

-- DM permissions: default deny; written ONLY by humans (I4). subject_id is an
-- agent/user/team/product id, or a SenderRelationship for subject_kind='relationship'.
create table public.dm_permissions (
  owner_user_id uuid not null references public.users (id) on delete cascade,
  subject_kind text not null check (subject_kind in ('agent', 'user', 'team', 'product', 'relationship')),
  subject_id text not null check (subject_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  policy text not null check (policy in ('allow', 'request', 'deny')),
  delivery text not null default 'next_turn' check (delivery in ('wake', 'next_turn', 'digest')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_user_id, subject_kind, subject_id),
  check (subject_kind <> 'relationship'
         or subject_id in ('self', 'teammate', 'contact', 'followed', 'customer', 'stranger'))
);

create table public.work_claims (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  thread_id paceline_private.ulid not null references public.threads (id) on delete cascade,
  repo_key paceline_private.sha256_hex,
  agent_id uuid not null references public.agents (id) on delete cascade,
  -- `]` first in the bracket expression is a literal.
  area_glob text not null check (area_glob ~ '^[]A-Za-z0-9_.*?/{}[,!@+-]{1,200}$'),
  -- Agent-written, so only the worker sets it (after screening).
  note text check (char_length(note) <= 200),
  until timestamptz not null,
  created_at timestamptz not null default now()
);
create index work_claims_thread_idx on public.work_claims (thread_id, until);
create index work_claims_repo_idx on public.work_claims (repo_key, until) where repo_key is not null;

-- Wake budget ledger (6/h and 30/day per recipient, 3/h per sender).
create table public.wake_ledger (
  id bigint generated always as identity primary key,
  recipient_agent_id uuid not null references public.agents (id) on delete cascade,
  sender_agent_id uuid references public.agents (id) on delete set null,
  message_id paceline_private.ulid references public.messages (id) on delete set null,
  outcome text not null check (outcome in ('woken', 'coalesced', 'over_budget', 'quiet_hours', 'no_session')),
  at timestamptz not null default now()
);
create index wake_ledger_recipient_idx on public.wake_ledger (recipient_agent_id, at desc);
create index wake_ledger_sender_idx on public.wake_ledger (sender_agent_id, at desc);

-- Realtime fan-out rows: ids/counts only (I3). Kept 7 days.
create table public.events (
  id bigserial primary key,
  type text not null check (type in ('activity.published', 'activity.updated', 'message.new', 'message.delivered',
                                     'review.new', 'review.decided', 'change.updated', 'presence', 'rollup.updated',
                                     'owner_instruction.new', 'suggestion.ready', 'thread.escalated', 'wake.requested',
                                     'kill_switch.changed', 'takedown')),
  audience_agent_ids uuid[] not null default '{}' check (cardinality(audience_agent_ids) <= 100),
  audience_user_ids uuid[] not null default '{}' check (cardinality(audience_user_ids) <= 100),
  payload jsonb not null default '{}' check (paceline_private.event_payload_ok(payload)),
  created_at timestamptz not null default now()
);
create index events_created_at_idx on public.events (created_at);
create index events_audience_agents_gin on public.events using gin (audience_agent_ids);
create index events_audience_users_gin on public.events using gin (audience_user_ids);

-- ========================================================= safety and approvals

-- The human decision queue. decision_id is the client's idempotency key for
-- the decision and is unique across all items.
create table public.review_items (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  owner_user_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (kind in ('draft', 'quarantined_message', 'dm_request', 'change_request', 'builder_reply', 'report')),
  ref_id paceline_private.prefixed_id not null,
  agent_id uuid references public.agents (id) on delete set null,
  -- Templated by core from ids/counts; never third-party text.
  summary text not null default '' check (char_length(summary) <= 200),
  state text not null default 'pending' check (state in ('pending', 'approved', 'rejected', 'expired')),
  decision text check (decision in ('approve', 'reject', 'release', 'hold')),
  decision_id text unique check (decision_id ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  decided_by uuid references public.users (id) on delete set null,
  decided_via text check (decided_via in ('web', 'slack', 'native_prompt')),
  decided_at timestamptz,
  slack_sent boolean not null default false,
  requires_step_up boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'pending') = (decided_at is null) or state = 'expired')
);
create index review_items_owner_idx on public.review_items (owner_user_id, state, created_at desc);
-- At most one pending item per referenced object and kind.
create unique index review_items_pending_ref_idx on public.review_items (kind, ref_id) where state = 'pending';

create table public.reports (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  reporter_user_id uuid not null references public.users (id) on delete cascade,
  target_kind text not null check (target_kind in ('activity', 'highlight', 'message', 'component', 'review')),
  target_id paceline_private.prefixed_id not null,
  reason text not null check (reason in ('injection', 'secrets', 'spam', 'harassment', 'malicious_setup', 'other')),
  review_item_id paceline_private.ulid references public.review_items (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (reporter_user_id, target_id)
);
create index reports_target_idx on public.reports (target_id);

-- ======================================================================= scroll

create table public.setup_suggestions (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  segment_id uuid references public.segments (id) on delete set null,
  stack_key text check (stack_key ~ '^[a-z0-9.+#@_,-]{1,200}$'),
  shared_component_id paceline_private.ulid references public.shared_components (id) on delete cascade,
  kind text not null check (kind in ('add_skill', 'claude_md_block', 'workflow_tip')),
  capability_tags text[] not null default '{}' check (paceline_private.text_array_ok(capability_tags, '^[a-z][a-z0-9_]{0,39}$', 8)),
  applies_to_intents text[] not null default '{}' check (cardinality(applies_to_intents) <= 8),
  evidence jsonb not null default '{}' check (jsonb_typeof(evidence) = 'object'),
  patch jsonb not null check (jsonb_typeof(patch) = 'object' and octet_length(patch::text) <= 131072),
  patch_hash paceline_private.sha256_hex not null,
  static_report jsonb not null default '[]',
  static_outcome text check (static_outcome in ('pass', 'warn', 'fail')),
  -- Copied from the verdict (SetupSuggestion.risk.verdict, ChangeRequest.screen).
  screen_label paceline_private.label,
  screen_layers paceline_private.screen_layers,
  screen_action paceline_private.screen_action,
  screen_categories paceline_private.screen_categories not null default '{}',
  verdict_id paceline_private.ulid references public.verdicts (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'ready', 'stale', 'withdrawn')),
  scope text not null default 'team' check (scope in ('team', 'public-aggregate')),
  team_id uuid references public.teams (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (scope <> 'team' or team_id is not null)
);
create index setup_suggestions_segment_idx on public.setup_suggestions (segment_id, status);

create table public.change_requests (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  owner_user_id uuid not null references public.users (id) on delete cascade,
  suggestion_id paceline_private.ulid references public.setup_suggestions (id) on delete set null,
  target text not null check (target in ('user', 'local', 'project_pr')),
  repo_key paceline_private.sha256_hex,
  patch jsonb not null check (jsonb_typeof(patch) = 'object' and octet_length(patch::text) <= 131072),
  patch_hash paceline_private.sha256_hex not null,
  base_hashes jsonb not null default '{}' check (jsonb_typeof(base_hashes) = 'object'),
  state text not null default 'pending_approval'
    check (state in ('pending_approval', 'approved', 'applied', 'failed', 'rejected', 'rolled_back', 'expired')),
  kid paceline_private.key_id,
  signature paceline_private.ed25519_sig,
  approved_by uuid references public.users (id) on delete set null,
  approved_at timestamptz,
  applied_at timestamptz,
  post_hashes jsonb check (post_hashes is null or jsonb_typeof(post_hashes) = 'object'),
  pr_url text check (pr_url ~ '^https://[A-Za-z0-9.-]+/[A-Za-z0-9._~/%-]{1,400}$'),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (target <> 'project_pr' or repo_key is not null),
  check (patch ->> 'target' = target),
  check (state not in ('approved', 'applied', 'rolled_back') or (signature is not null and kid is not null and approved_by is not null))
);
create index change_requests_agent_idx on public.change_requests (agent_id, state);
create index change_requests_owner_idx on public.change_requests (owner_user_id, created_at desc);

create table public.adoptions (
  change_request_id paceline_private.ulid primary key references public.change_requests (id) on delete cascade,
  baseline jsonb not null default '{}',
  post jsonb not null default '{}',
  n_post integer not null default 0 check (n_post >= 0),
  delta_success real,
  delta_tokens real,
  ci95_low real,
  ci95_high real,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ===================================================================== builders

create table public.builder_tasks (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  product_id paceline_private.ulid not null references public.products (id) on delete cascade,
  thread_id paceline_private.ulid references public.threads (id) on delete set null,
  source_message_id paceline_private.ulid references public.messages (id) on delete set null,
  state text not null default 'open' check (state in ('open', 'triaged', 'in_progress', 'done', 'wontfix')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index builder_tasks_product_idx on public.builder_tasks (product_id, state);

-- ================================================================ infra + slack

-- Durable jobs: claimed with FOR UPDATE SKIP LOCKED (api.claim_jobs). The
-- dedupe_key is unique for the row's lifetime: enqueue with
-- `on conflict (dedupe_key) do nothing`; time-bucket keys for recurring work.
create table public.jobs (
  id bigserial primary key,
  topic text not null check (topic ~ '^[a-z][a-z0-9_.]{0,62}$'),
  payload jsonb not null default '{}' check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 16384),
  dedupe_key text unique check (char_length(dedupe_key) between 1 and 200),
  state text not null default 'queued' check (state in ('queued', 'running', 'done', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 50),
  run_after timestamptz not null default now(),
  locked_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text check (char_length(last_error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state <> 'running' or locked_until is not null)
);
create index jobs_queued_idx on public.jobs (topic, run_after, id) where state = 'queued';
create index jobs_running_lease_idx on public.jobs (locked_until) where state = 'running';
create index jobs_finished_idx on public.jobs (finished_at) where state in ('done', 'dead');

-- Postgres token buckets (api.take_token).
create table public.rate_buckets (
  key text primary key check (char_length(key) between 1 and 200),
  tokens double precision not null,
  updated_at timestamptz not null default now()
);
create index rate_buckets_updated_idx on public.rate_buckets (updated_at);

create table public.notification_prefs (
  user_id uuid primary key references public.users (id) on delete cascade,
  channels jsonb not null default '{"web": true, "slack": false}' check (jsonb_typeof(channels) = 'object'),
  batching text not null default 'immediate' check (batching in ('immediate', 'hourly', 'daily')),
  kinds jsonb not null default '{}' check (jsonb_typeof(kinds) = 'object'),
  updated_at timestamptz not null default now()
);

-- Slack workspace installs. bot_token_secret_name names a Vault secret (or
-- env var); the token itself is never stored in a table.
create table public.slack_installations (
  id uuid primary key default gen_random_uuid(),
  slack_team_id text not null unique check (slack_team_id ~ '^[A-Z0-9]{5,20}$'),
  enterprise_id text check (enterprise_id ~ '^[A-Z0-9]{5,20}$'),
  team_name text check (char_length(team_name) <= 80),
  bot_user_id text check (bot_user_id ~ '^[A-Z0-9]{5,20}$'),
  bot_token_secret_name text check (char_length(bot_token_secret_name) <= 200),
  installed_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table public.slack_identity_links (
  slack_team_id text not null check (slack_team_id ~ '^[A-Z0-9]{5,20}$'),
  slack_user_id text not null check (slack_user_id ~ '^[A-Z0-9]{5,20}$'),
  user_id uuid not null references public.users (id) on delete cascade,
  -- Copied from slack_installations.team_name when linking (SlackLink.workspaceName),
  -- so the settings page never needs the service-only installations table.
  slack_team_name text check (char_length(slack_team_name) <= 80),
  linked_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (slack_team_id, slack_user_id),
  unique (user_id, slack_team_id)
);

-- Single-use link tokens from `/paceline connect` (sha256 only). Consumed by
-- api.complete_slack_link() inside a web session.
create table public.slack_link_tokens (
  token_hash paceline_private.sha256_hex primary key,
  slack_team_id text not null check (slack_team_id ~ '^[A-Z0-9]{5,20}$'),
  slack_user_id text not null check (slack_user_id ~ '^[A-Z0-9]{5,20}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references public.users (id) on delete set null
);

create table public.thread_bridges (
  thread_id paceline_private.ulid not null references public.threads (id) on delete cascade,
  slack_team_id text not null check (slack_team_id ~ '^[A-Z0-9]{5,20}$'),
  channel_id text not null check (channel_id ~ '^[A-Z0-9]{5,20}$'),
  thread_ts text not null check (thread_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  created_at timestamptz not null default now(),
  primary key (thread_id, slack_team_id),
  unique (slack_team_id, channel_id, thread_ts)
);

create table public.slack_events_seen (
  event_id text primary key check (char_length(event_id) between 1 and 128),
  seen_at timestamptz not null default now()
);
create index slack_events_seen_at_idx on public.slack_events_seen (seen_at);

-- ============================================================ prompt feedback

-- Feedback on the human's own prompting (PLAN §8). Private to the user.
create table public.prompt_feedback (
  id paceline_private.ulid primary key default paceline_private.ulid(),
  user_id uuid not null references public.users (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete set null,
  activity_id paceline_private.ulid references public.activities (id) on delete set null,
  segment_id uuid references public.segments (id) on delete set null,
  task_intent paceline_private.task_intent,
  kind text not null check (kind in ('phrasing', 'context', 'framing', 'scope', 'decomposition', 'verification', 'other')),
  observation text not null check (char_length(observation) between 1 and 600),
  suggestion text not null default '' check (char_length(suggestion) <= 1200),
  -- {n, turnsDelta, tokensDelta, scope}: counts and deltas only.
  evidence jsonb not null default '{}' check (jsonb_typeof(evidence) = 'object'),
  helpful boolean,
  dismissed_at timestamptz,
  created_at timestamptz not null default now()
);
create index prompt_feedback_user_idx on public.prompt_feedback (user_id, created_at desc);
