begin;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists one_fetch;
revoke all on schema one_fetch from public, anon, authenticated;
grant usage on schema one_fetch to service_role;

create table one_fetch.migration_history (
  version text primary key,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default clock_timestamp()
);

create table one_fetch.instance_state (
  singleton boolean primary key default true check (singleton),
  instance_id uuid not null unique,
  initialized boolean not null default false,
  gateway_paused boolean not null default false,
  config_revision bigint not null default 0 check (config_revision >= 0),
  config_version text not null,
  active_config jsonb not null check (jsonb_typeof(active_config) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table one_fetch.admins (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  username_normalized text generated always as (lower(btrim(username))) stored unique,
  password_hash text not null,
  totp_ciphertext text,
  recovery_codes_ciphertext text,
  failed_login_count integer not null default 0 check (failed_login_count >= 0),
  locked_until timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  last_login_at timestamptz
);

create table one_fetch.sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references one_fetch.admins(id) on delete cascade,
  family_id uuid not null,
  access_token_hash text not null unique check (access_token_hash ~ '^[0-9a-f]{64}$'),
  refresh_token_hash text not null unique check (refresh_token_hash ~ '^[0-9a-f]{64}$'),
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  device_label text,
  client_fingerprint text,
  created_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text
);

create index sessions_admin_active_idx
  on one_fetch.sessions (admin_id, refresh_expires_at desc)
  where revoked_at is null;

create table one_fetch.refresh_token_history (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  family_id uuid not null,
  session_id uuid not null references one_fetch.sessions(id) on delete cascade,
  rotated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);

create index refresh_token_history_expiry_idx
  on one_fetch.refresh_token_history (expires_at);

create table one_fetch.execution_tokens (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 128),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scopes jsonb not null default '{"transports":["http"],"origins":[],"ports":[]}'::jsonb,
  quotas jsonb not null default '{"requestsPerMinute":60,"burst":10,"concurrentHttp":4,"concurrentTunnels":2,"bytesPerDay":1073741824}'::jsonb,
  created_by uuid not null references one_fetch.admins(id),
  created_at timestamptz not null default clock_timestamp(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  check (jsonb_typeof(scopes) = 'object'),
  check (jsonb_typeof(quotas) = 'object')
);

create table one_fetch.config_revisions (
  revision bigint primary key,
  version text not null unique,
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  config_hash text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  changed_fields text[] not null default '{}',
  changed_by uuid references one_fetch.admins(id),
  created_at timestamptz not null default clock_timestamp()
);

create table one_fetch.audit_events (
  sequence bigint generated always as identity primary key,
  event_id uuid not null unique,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  category text not null check (category in ('execution', 'auth', 'account', 'config', 'security', 'system', 'audit')),
  action text not null,
  outcome text not null check (outcome in ('success', 'denied', 'failure', 'partial', 'unknown')),
  severity text not null check (severity in ('info', 'warning', 'error', 'critical')),
  actor_type text not null check (actor_type in ('admin', 'execution-token', 'system', 'anonymous')),
  actor_id text,
  request_id text,
  report_id text,
  connection_id text,
  config_version text,
  provider_request_id text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  signature text not null,
  key_id text not null
);

create index audit_events_occurred_idx on one_fetch.audit_events (occurred_at desc, sequence desc);
create index audit_events_category_idx on one_fetch.audit_events (category, sequence desc);
create index audit_events_request_idx on one_fetch.audit_events (request_id, sequence) where request_id is not null;
create index audit_events_actor_idx on one_fetch.audit_events (actor_type, actor_id, sequence desc);

create table one_fetch.audit_daily_seals (
  seal_date date not null,
  category_group text not null check (category_group in ('execution', 'security')),
  first_sequence bigint not null,
  last_sequence bigint not null,
  event_count bigint not null check (event_count >= 0),
  merkle_root text not null,
  previous_seal_hash text,
  seal_hash text not null,
  signature text not null,
  key_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (seal_date, category_group)
);

create table one_fetch.execution_reports (
  report_id uuid primary key,
  request_id text not null,
  execution_token_id uuid references one_fetch.execution_tokens(id) on delete set null,
  outcome text not null,
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '10 minutes')
);

create unique index execution_reports_request_idx
  on one_fetch.execution_reports (request_id, report_id);
create index execution_reports_expiry_idx on one_fetch.execution_reports (expires_at);

create table one_fetch.quota_windows (
  execution_token_id uuid not null references one_fetch.execution_tokens(id) on delete cascade,
  bucket_kind text not null check (bucket_kind in ('minute', 'day')),
  bucket_start timestamptz not null,
  request_count bigint not null default 0 check (request_count >= 0),
  request_bytes bigint not null default 0 check (request_bytes >= 0),
  response_bytes bigint not null default 0 check (response_bytes >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (execution_token_id, bucket_kind, bucket_start)
);

create table one_fetch.execution_leases (
  lease_id uuid primary key default gen_random_uuid(),
  execution_token_id uuid not null references one_fetch.execution_tokens(id) on delete cascade,
  request_id text not null,
  transport text not null check (transport in ('http', 'websocket', 'tcp', 'tls')),
  acquired_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  unique (execution_token_id, request_id)
);

create index execution_leases_active_idx
  on one_fetch.execution_leases (execution_token_id, transport, expires_at);

create table one_fetch.webhook_outbox (
  event_id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp()
);

create index webhook_outbox_pending_idx
  on one_fetch.webhook_outbox (next_attempt_at)
  where delivered_at is null;

create or replace function one_fetch.append_audit(p_event jsonb)
returns uuid
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_event_id uuid := coalesce((p_event ->> 'eventId')::uuid, gen_random_uuid());
begin
  insert into audit_events (
    event_id,
    occurred_at,
    category,
    action,
    outcome,
    severity,
    actor_type,
    actor_id,
    request_id,
    report_id,
    connection_id,
    config_version,
    provider_request_id,
    payload,
    payload_hash,
    signature,
    key_id
  ) values (
    v_event_id,
    coalesce((p_event ->> 'occurredAt')::timestamptz, clock_timestamp()),
    p_event ->> 'category',
    p_event ->> 'action',
    p_event ->> 'outcome',
    p_event ->> 'severity',
    p_event #>> '{actor,type}',
    p_event #>> '{actor,actorId}',
    p_event #>> '{correlation,requestId}',
    p_event #>> '{correlation,reportId}',
    p_event #>> '{correlation,connectionId}',
    p_event #>> '{correlation,configVersion}',
    p_event #>> '{correlation,providerRequestId}',
    p_event - 'integrity',
    p_event #>> '{integrity,payloadHash}',
    p_event #>> '{integrity,signature}',
    p_event #>> '{integrity,keyId}'
  );
  return v_event_id;
exception
  when invalid_text_representation then
    raise exception using errcode = '22023', message = 'invalid audit event identifier or timestamp';
end;
$$;

alter default privileges in schema one_fetch revoke all on tables from public, anon, authenticated;
alter default privileges in schema one_fetch revoke all on sequences from public, anon, authenticated;
alter default privileges in schema one_fetch revoke all on functions from public, anon, authenticated;
revoke all on function one_fetch.append_audit(jsonb) from public, anon, authenticated;

-- one-fetch-self-checksum-v1: fa2880cabc22ef229c73da48343050f28b6f04cd1e99ca0be9e006b169035ed2
insert into one_fetch.migration_history (version, checksum)
values ('202609040001', 'fa2880cabc22ef229c73da48343050f28b6f04cd1e99ca0be9e006b169035ed2');

commit;
