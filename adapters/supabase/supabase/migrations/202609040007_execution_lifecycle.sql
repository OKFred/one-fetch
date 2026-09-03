begin;

alter table one_fetch.instance_state
  add column audit_degraded boolean not null default false;

alter table one_fetch.execution_leases
  add column request_bytes bigint not null default 0
  check (request_bytes >= 0);

alter table one_fetch.execution_reports
  add column lease_id uuid;

create unique index execution_reports_lease_idx
  on one_fetch.execution_reports (lease_id)
  where lease_id is not null;

create or replace function public.of_get_instance_state()
returns jsonb
language sql
stable
security definer
set search_path = one_fetch, pg_temp
as $$
  select coalesce((
    select jsonb_build_object(
      'instanceId', instance_id, 'initialized', initialized,
      'gatewayPaused', gateway_paused, 'configRevision', config_revision,
      'configVersion', config_version, 'updatedAt', updated_at,
      'auditDegraded', audit_degraded
    ) from instance_state where singleton
  ), '{"initialized":false,"auditDegraded":false}'::jsonb);
$$;

create or replace function public.of_get_active_config()
returns jsonb
language sql
stable
security definer
set search_path = one_fetch, pg_temp
as $$
  select coalesce((
    select jsonb_build_object(
      'instanceId', instance_id, 'initialized', initialized,
      'gatewayPaused', gateway_paused, 'revision', config_revision,
      'version', config_version, 'config', active_config,
      'updatedAt', updated_at, 'auditDegraded', audit_degraded
    ) from instance_state where singleton
  ), '{"initialized":false,"auditDegraded":false}'::jsonb);
$$;

create or replace function public.of_acquire_execution(
  p_token_id uuid,
  p_request_id text,
  p_transport text,
  p_request_bytes bigint,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_quotas jsonb;
  v_rpm integer;
  v_concurrency integer;
  v_tunnels integer;
  v_daily_bytes bigint;
  v_count bigint;
  v_bytes bigint;
  v_active bigint;
  v_lease_id uuid;
  v_now timestamptz;
  v_minute timestamptz;
  v_day timestamptz;
begin
  if p_token_id is null or p_request_id is null or p_request_id = ''
     or p_transport is null
     or p_transport not in ('http', 'websocket', 'tcp', 'tls')
     or p_request_bytes is null or p_request_bytes < 0
     or p_lease_seconds is null then
    return jsonb_build_object('allowed', false, 'reason', 'request_invalid');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_token_id::text));
  select quotas into v_quotas
  from execution_tokens
  where id = p_token_id and revoked_at is null;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'token_invalid');
  end if;

  v_now := clock_timestamp();
  v_minute := date_trunc('minute', v_now);
  v_day := date_trunc('day', v_now);
  v_rpm := coalesce((v_quotas ->> 'requestsPerMinute')::integer, 60);
  v_concurrency := coalesce((v_quotas ->> 'concurrentHttp')::integer, 4);
  v_tunnels := coalesce((v_quotas ->> 'concurrentTunnels')::integer, 2);
  v_daily_bytes := coalesce((v_quotas ->> 'bytesPerDay')::bigint, 1073741824);
  delete from execution_leases where expires_at <= v_now;

  insert into quota_windows (
    execution_token_id, bucket_kind, bucket_start, request_count, request_bytes
  ) values (
    p_token_id, 'minute', v_minute, 1, p_request_bytes
  ) on conflict (execution_token_id, bucket_kind, bucket_start) do update
    set request_count = quota_windows.request_count + 1,
        request_bytes = quota_windows.request_bytes + excluded.request_bytes,
        updated_at = v_now
  returning request_count into v_count;

  insert into quota_windows (
    execution_token_id, bucket_kind, bucket_start, request_count, request_bytes
  ) values (
    p_token_id, 'day', v_day, 1, p_request_bytes
  ) on conflict (execution_token_id, bucket_kind, bucket_start) do update
    set request_count = quota_windows.request_count + 1,
        request_bytes = quota_windows.request_bytes + excluded.request_bytes,
        updated_at = v_now
  returning request_bytes + response_bytes into v_bytes;

  if v_count > v_rpm then
    return jsonb_build_object(
      'allowed', false, 'reason', 'rate_limit', 'retryAfterSeconds', 60
    );
  end if;
  if v_bytes > v_daily_bytes then
    return jsonb_build_object('allowed', false, 'reason', 'daily_bytes');
  end if;

  select count(*) into v_active
  from execution_leases
  where execution_token_id = p_token_id
    and expires_at > v_now
    and case
      when p_transport = 'http' then transport = 'http'
      else transport <> 'http'
    end;
  if (p_transport = 'http' and v_active >= v_concurrency)
     or (p_transport <> 'http' and v_active >= v_tunnels) then
    return jsonb_build_object('allowed', false, 'reason', 'concurrency');
  end if;

  insert into execution_leases (
    execution_token_id, request_id, transport, acquired_at, expires_at,
    request_bytes
  ) values (
    p_token_id, p_request_id, p_transport, v_now,
    v_now + make_interval(secs => least(greatest(p_lease_seconds, 1), 1200)),
    p_request_bytes
  ) returning lease_id into v_lease_id;
  return jsonb_build_object('allowed', true, 'leaseId', v_lease_id);
end;
$$;

create or replace function public.of_reconcile_execution_request(
  p_lease_id uuid,
  p_request_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_token_id uuid;
  v_previous bigint;
  v_acquired_at timestamptz;
  v_daily_limit bigint;
  v_daily_total bigint;
  v_minute_bytes bigint;
  v_delta bigint;
begin
  select leases.execution_token_id, leases.request_bytes, leases.acquired_at,
         coalesce((tokens.quotas ->> 'bytesPerDay')::bigint, 1073741824)
  into v_token_id, v_previous, v_acquired_at, v_daily_limit
  from execution_leases leases
  join execution_tokens tokens on tokens.id = leases.execution_token_id
  where leases.lease_id = p_lease_id
  for update of leases;

  if not found or p_request_bytes is null or p_request_bytes < 0 then
    return jsonb_build_object('allowed', false, 'reason', 'lease_invalid');
  end if;

  if v_previous <> 0 and v_previous <> p_request_bytes then
    return jsonb_build_object(
      'allowed', false, 'reason', 'request_bytes_conflict'
    );
  end if;

  select request_bytes into v_minute_bytes
  from quota_windows
  where execution_token_id = v_token_id
    and bucket_kind = 'minute'
    and bucket_start = date_trunc('minute', v_acquired_at)
  for update;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'quota_state_invalid');
  end if;

  select request_bytes + response_bytes into v_daily_total
  from quota_windows
  where execution_token_id = v_token_id
    and bucket_kind = 'day'
    and bucket_start = date_trunc('day', v_acquired_at)
  for update;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'quota_state_invalid');
  end if;

  v_delta := p_request_bytes - v_previous;
  if v_delta <> 0 then
    update quota_windows
    set request_bytes = greatest(request_bytes + v_delta, 0),
        updated_at = clock_timestamp()
    where execution_token_id = v_token_id
      and bucket_kind = 'minute'
      and bucket_start = date_trunc('minute', v_acquired_at);

    update quota_windows
    set request_bytes = greatest(request_bytes + v_delta, 0),
        updated_at = clock_timestamp()
    where execution_token_id = v_token_id
      and bucket_kind = 'day'
      and bucket_start = date_trunc('day', v_acquired_at)
    returning request_bytes + response_bytes into v_daily_total;

    update execution_leases
    set request_bytes = p_request_bytes
    where lease_id = p_lease_id;
  end if;

  if coalesce(v_daily_total, 0) > v_daily_limit then
    return jsonb_build_object('allowed', false, 'reason', 'daily_bytes');
  end if;
  return jsonb_build_object('allowed', true);
end;
$$;

create or replace function public.of_finalize_execution(
  p_lease_id uuid,
  p_response_bytes bigint,
  p_report_id uuid,
  p_request_id text,
  p_token_id uuid,
  p_outcome text,
  p_report jsonb,
  p_expires_at timestamptz,
  p_audit jsonb,
  p_prior_audit_degraded boolean
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_existing execution_reports%rowtype;
  v_lease_token_id uuid;
  v_lease_request_id text;
  v_audit_state text := case
    when p_prior_audit_degraded then 'degraded'
    else 'recorded'
  end;
  v_retry_report jsonb;
  v_final_report jsonb;
begin
  if p_lease_id is null or p_report_id is null or p_token_id is null
     or p_request_id is null or p_request_id = ''
     or p_response_bytes is null or p_response_bytes < 0
     or p_expires_at is null or p_prior_audit_degraded is null
     or p_outcome is null or p_outcome not in (
       'completed', 'partial', 'timeout', 'cancelled', 'relay-error', 'orphaned'
     ) then
    raise exception using errcode = '22023', message = 'execution_finalization_invalid';
  end if;
  if jsonb_typeof(p_report) is distinct from 'object'
     or (p_report ->> 'reportId') is distinct from p_report_id::text
     or (p_report ->> 'requestId') is distinct from p_request_id
     or (p_report ->> 'outcome') is distinct from p_outcome
     or (p_report -> 'responseBytes') is distinct from to_jsonb(p_response_bytes)
     or (p_report ->> 'auditState') is null
     or (p_report ->> 'auditState') not in ('recorded', 'degraded', 'unknown') then
    raise exception using errcode = '22023', message = 'execution_report_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_report_id::text));
  select * into v_existing
  from execution_reports
  where report_id = p_report_id
  for update;
  if found then
    if (v_existing.report ->> 'auditState') not in ('recorded', 'degraded') then
      raise exception using errcode = 'P0001', message = 'execution_finalization_conflict';
    end if;
    v_retry_report := jsonb_set(
      p_report,
      '{auditState}',
      to_jsonb(v_existing.report ->> 'auditState'),
      true
    );
    if v_existing.lease_id = p_lease_id
       and v_existing.request_id = p_request_id
       and v_existing.execution_token_id = p_token_id
       and v_existing.outcome = p_outcome
       and v_existing.report = v_retry_report then
      return jsonb_build_object(
        'status', 'already_finalized',
        'auditState', v_existing.report ->> 'auditState'
      );
    end if;
    raise exception using errcode = 'P0001', message = 'execution_finalization_conflict';
  end if;

  select execution_token_id, request_id
  into v_lease_token_id, v_lease_request_id
  from execution_leases
  where lease_id = p_lease_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'execution_lease_missing';
  end if;
  if v_lease_token_id <> p_token_id or v_lease_request_id <> p_request_id then
    raise exception using errcode = '22023', message = 'execution_binding_mismatch';
  end if;
  if p_audit is null then
    if not p_prior_audit_degraded then
      raise exception using errcode = '22023', message = 'execution_audit_invalid';
    end if;
  else
    if jsonb_typeof(p_audit) is distinct from 'object'
       or (p_audit #>> '{actor,actorId}') is distinct from p_token_id::text
       or (p_audit #>> '{correlation,requestId}') is distinct from p_request_id
       or (p_audit #>> '{correlation,reportId}') is distinct from p_report_id::text then
      raise exception using errcode = '22023', message = 'execution_audit_invalid';
    end if;

    begin
      perform append_audit(p_audit);
    exception when others then
      v_audit_state := 'degraded';
    end;
  end if;
  if v_audit_state = 'degraded' then
    update instance_state
    set audit_degraded = true,
        updated_at = clock_timestamp()
    where singleton;
    if not found then
      raise exception using errcode = 'P0001', message = 'instance_state_missing';
    end if;
  end if;

  if not public.of_release_execution(p_lease_id, p_response_bytes) then
    raise exception using errcode = 'P0001', message = 'execution_lease_release_failed';
  end if;
  v_final_report := jsonb_set(
    p_report, '{auditState}', to_jsonb(v_audit_state), true
  );
  insert into execution_reports (
    report_id, request_id, execution_token_id, lease_id, outcome, report,
    expires_at
  ) values (
    p_report_id, p_request_id, p_token_id, p_lease_id, p_outcome,
    v_final_report, p_expires_at
  );
  return jsonb_build_object('status', 'finalized', 'auditState', v_audit_state);
end;
$$;

revoke all on function public.of_reconcile_execution_request(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.of_reconcile_execution_request(uuid, bigint)
  to service_role;
revoke all on function public.of_finalize_execution(
  uuid, bigint, uuid, text, uuid, text, jsonb, timestamptz, jsonb, boolean
) from public, anon, authenticated;
grant execute on function public.of_finalize_execution(
  uuid, bigint, uuid, text, uuid, text, jsonb, timestamptz, jsonb, boolean
) to service_role;

insert into one_fetch.migration_history (version, checksum)
values (
  '202609040007',
  encode(extensions.digest(
    convert_to('one-fetch-supabase-execution-lifecycle-v1', 'UTF8'),
    'sha256'
  ), 'hex')
);

commit;
