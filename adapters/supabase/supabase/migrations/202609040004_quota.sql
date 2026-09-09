begin;

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
  v_minute timestamptz := date_trunc('minute', clock_timestamp());
  v_day timestamptz := date_trunc('day', clock_timestamp());
begin
  perform pg_advisory_xact_lock(hashtext(p_token_id::text));
  select quotas into v_quotas
  from execution_tokens
  where id = p_token_id and revoked_at is null;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'token_invalid');
  end if;

  v_rpm := coalesce((v_quotas ->> 'requestsPerMinute')::integer, 60);
  v_concurrency := coalesce((v_quotas ->> 'concurrentHttp')::integer, 4);
  v_tunnels := coalesce((v_quotas ->> 'concurrentTunnels')::integer, 2);
  v_daily_bytes := coalesce((v_quotas ->> 'bytesPerDay')::bigint, 1073741824);

  delete from execution_leases where expires_at <= clock_timestamp();

  insert into quota_windows (
    execution_token_id,
    bucket_kind,
    bucket_start,
    request_count,
    request_bytes
  ) values (
    p_token_id,
    'minute',
    v_minute,
    1,
    greatest(p_request_bytes, 0)
  ) on conflict (execution_token_id, bucket_kind, bucket_start) do update
    set request_count = quota_windows.request_count + 1,
        request_bytes = quota_windows.request_bytes + greatest(excluded.request_bytes, 0),
        updated_at = clock_timestamp()
  returning request_count into v_count;

  insert into quota_windows (
    execution_token_id,
    bucket_kind,
    bucket_start,
    request_count,
    request_bytes
  ) values (
    p_token_id,
    'day',
    v_day,
    1,
    greatest(p_request_bytes, 0)
  ) on conflict (execution_token_id, bucket_kind, bucket_start) do update
    set request_count = quota_windows.request_count + 1,
        request_bytes = quota_windows.request_bytes + greatest(excluded.request_bytes, 0),
        updated_at = clock_timestamp()
  returning request_bytes + response_bytes into v_bytes;

  if v_count > v_rpm then
    return jsonb_build_object('allowed', false, 'reason', 'rate_limit', 'retryAfterSeconds', 60);
  end if;
  if v_bytes > v_daily_bytes then
    return jsonb_build_object('allowed', false, 'reason', 'daily_bytes');
  end if;

  select count(*) into v_active
  from execution_leases
  where execution_token_id = p_token_id
    and expires_at > clock_timestamp()
    and case
      when p_transport = 'http' then transport = 'http'
      else transport <> 'http'
    end;

  if (p_transport = 'http' and v_active >= v_concurrency)
     or (p_transport <> 'http' and v_active >= v_tunnels) then
    return jsonb_build_object('allowed', false, 'reason', 'concurrency');
  end if;

  insert into execution_leases (
    execution_token_id,
    request_id,
    transport,
    expires_at
  ) values (
    p_token_id,
    p_request_id,
    p_transport,
    clock_timestamp() + make_interval(secs => least(greatest(p_lease_seconds, 1), 1200))
  ) returning lease_id into v_lease_id;

  return jsonb_build_object('allowed', true, 'leaseId', v_lease_id);
end;
$$;

create or replace function public.of_release_execution(
  p_lease_id uuid,
  p_response_bytes bigint
)
returns boolean
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_token_id uuid;
  v_day timestamptz := date_trunc('day', clock_timestamp());
begin
  delete from execution_leases
  where lease_id = p_lease_id
  returning execution_token_id into v_token_id;
  if not found then
    return false;
  end if;

  insert into quota_windows (
    execution_token_id,
    bucket_kind,
    bucket_start,
    response_bytes
  ) values (
    v_token_id,
    'day',
    v_day,
    greatest(p_response_bytes, 0)
  ) on conflict (execution_token_id, bucket_kind, bucket_start) do update
    set response_bytes = quota_windows.response_bytes + greatest(excluded.response_bytes, 0),
        updated_at = clock_timestamp();
  return true;
end;
$$;

create or replace function public.of_cleanup_expired()
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_reports integer;
  v_history integer;
  v_leases integer;
begin
  delete from execution_reports where expires_at <= clock_timestamp();
  get diagnostics v_reports = row_count;
  delete from refresh_token_history where expires_at <= clock_timestamp();
  get diagnostics v_history = row_count;
  delete from execution_leases where expires_at <= clock_timestamp();
  get diagnostics v_leases = row_count;
  return jsonb_build_object(
    'reports', v_reports,
    'refreshHistory', v_history,
    'leases', v_leases
  );
end;
$$;
revoke all on function public.of_acquire_execution(uuid, text, text, bigint, integer) from public, anon, authenticated;
grant execute on function public.of_acquire_execution(uuid, text, text, bigint, integer) to service_role;
revoke all on function public.of_release_execution(uuid, bigint) from public, anon, authenticated;
grant execute on function public.of_release_execution(uuid, bigint) to service_role;
revoke all on function public.of_cleanup_expired() from public, anon, authenticated;
grant execute on function public.of_cleanup_expired() to service_role;

-- one-fetch-self-checksum-v1: 5a64d5913d0abd63363c91932b91a1e010ce6782a08db21bb73a4bd88313a24e
insert into one_fetch.migration_history (version, checksum)
values ('202609040004', '5a64d5913d0abd63363c91932b91a1e010ce6782a08db21bb73a4bd88313a24e');

commit;
