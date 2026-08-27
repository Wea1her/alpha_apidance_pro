create table raw_events (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('alpha_hook', 'alpha_ws', 'legacy_import')),
  received_at timestamptz not null default now(),
  dedupe_key text not null unique,
  payload jsonb not null,
  decode_status text not null default 'pending'
    check (decode_status in ('pending', 'decoded', 'unsupported', 'invalid')),
  decode_error text
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  x_user_id text not null unique,
  current_handle text not null,
  display_name text not null default '',
  avatar_url text,
  status text not null default 'screening'
    check (status in ('screening', 'active', 'trench', 'dormant', 'pending_review', 'excluded')),
  highest_star smallint not null default 0 check (highest_star between 0 and 5),
  highest_common_follow_count integer not null default 0 check (highest_common_follow_count >= 0),
  surge_until timestamptz,
  last_material_update_at timestamptz,
  excluded_at timestamptz,
  exclusion_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table project_aliases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  handle text not null,
  display_name text,
  observed_at timestamptz not null default now(),
  unique (project_id, handle, observed_at)
);

create table signals (
  id uuid primary key default gen_random_uuid(),
  raw_event_id uuid not null references raw_events(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  x_user_id text,
  type text not null check (type in ('common_follow', 'new_tweet', 'ca', 'profile_change', 'unknown')),
  occurred_at timestamptz not null,
  common_follow_count integer check (common_follow_count is null or common_follow_count >= 0),
  x_post_id text,
  x_post_url text,
  content text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (raw_event_id, type)
);

create index signals_project_occurred_idx on signals (project_id, occurred_at desc);

create table screening_decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  decision text not null
    check (decision in ('allowed', 'blocked', 'failed', 'manual_allowed', 'manual_blocked')),
  account_type text not null
    check (account_type in ('PROJECT', 'ALPHA', 'UNKNOWN', 'KOL', 'PERSONAL', 'DEV', 'MEDIA')),
  reason text,
  provider_run_id uuid,
  created_at timestamptz not null default now(),
  audit_expires_at timestamptz
);

create table evidence (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  signal_id uuid references signals(id) on delete set null,
  source_type text not null
    check (source_type in ('alpha', 'x', 'official_web', 'docs', 'github', 'chain', 'other')),
  url text not null,
  title text not null default '',
  excerpt text not null default '',
  captured_at timestamptz not null default now(),
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  unique (project_id, content_hash)
);

create table ai_provider_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  base_url text not null,
  encrypted_api_key text not null,
  screening_model text not null,
  research_model text not null,
  protocol text not null check (protocol in ('openai_chat', 'xai_responses')),
  capabilities jsonb not null default '{}'::jsonb,
  role text not null check (role in ('main', 'fallback')),
  enabled boolean not null default true,
  health_status text not null default 'unknown'
    check (health_status in ('unknown', 'healthy', 'unhealthy')),
  last_health_check_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ai_provider_runs (
  id uuid primary key default gen_random_uuid(),
  provider_profile_id uuid references ai_provider_profiles(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  purpose text not null check (purpose in ('screening', 'research', 'materiality')),
  model text not null,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table screening_decisions
  add constraint screening_provider_run_fk
  foreign key (provider_run_id) references ai_provider_runs(id) on delete set null;

create table report_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  version integer not null check (version > 0),
  trigger_signal_id uuid references signals(id) on delete set null,
  status text not null
    check (status in ('queued', 'collecting', 'generating', 'ready', 'failed')),
  structured_document jsonb,
  rendered_markdown text,
  change_summary jsonb,
  provider_run_id uuid references ai_provider_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (project_id, version)
);

create table personal_notes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trench_memberships (
  project_id uuid primary key references projects(id) on delete cascade,
  entered_at timestamptz not null default now(),
  state text not null check (state in ('active', 'dormant', 'stopped')),
  dormant_at timestamptz,
  last_checked_at timestamptz
);

create table alpha_monitors (
  project_id uuid primary key references projects(id) on delete cascade,
  alpha_user_id text,
  alpha_group_id text,
  tweet_enabled boolean not null default false,
  ca_enabled boolean not null default false,
  desired_state text not null check (desired_state in ('enabled', 'disabled')),
  actual_state text not null check (actual_state in ('pending', 'enabled', 'disabled', 'error')),
  last_synced_at timestamptz,
  last_error text
);

create table surges (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  window_started_at timestamptz not null,
  baseline_count integer not null check (baseline_count >= 0),
  peak_count integer not null check (peak_count >= baseline_count),
  triggered_at timestamptz not null,
  expires_at timestamptz not null,
  notified_at timestamptz,
  unique (project_id, triggered_at)
);

create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  type text not null check (type in ('task', 'participation', 'cost', 'result', 'note')),
  status text not null check (status in ('planned', 'active', 'done', 'skipped')),
  amount_text text,
  content text not null,
  occurred_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table calendar_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  status text not null check (status in ('confirmed', 'pending')),
  source_evidence_id uuid references evidence(id) on delete set null,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  remind_24h boolean not null default true,
  remind_1h boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  priority integer not null default 100,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'retry', 'succeeded', 'dead')),
  idempotency_key text not null unique,
  payload jsonb not null,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 10 check (max_attempts > 0),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jobs_claim_idx on jobs (status, run_after, priority, created_at);

create table outbox_events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  version integer not null default 1,
  payload jsonb not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table outbox_deliveries (
  outbox_event_id uuid not null references outbox_events(id) on delete cascade,
  consumer text not null,
  delivered_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  primary key (outbox_event_id, consumer)
);

create table access_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now()
);

create table login_attempts (
  id uuid primary key default gen_random_uuid(),
  ip_address text not null,
  succeeded boolean not null,
  attempted_at timestamptz not null default now()
);
