begin;

create table one_fetch.deployment_state (
  singleton boolean primary key default true check (singleton),
  current_build text not null default 'none',
  pending_build text,
  lease_id uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check (
    (lease_id is null and lease_expires_at is null and pending_build is null)
    or
    (lease_id is not null and lease_expires_at is not null and pending_build is not null)
  )
);

create table one_fetch.deployment_events (
  sequence bigint generated always as identity primary key,
  occurred_at timestamptz not null default clock_timestamp(),
  event_type text not null check (event_type in (
    'lease-acquired', 'lease-renewed', 'deployment-completed', 'deployment-failed'
  )),
  expected_build text,
  desired_build text,
  reason_code text,
  lease_id uuid not null
);

insert into one_fetch.deployment_state (singleton) values (true);

create or replace function public.of_acquire_deployment_lease(
  p_expected_build text,
  p_desired_build text,
  p_lease_id uuid,
  p_ttl_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_state deployment_state%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_expected_build is null or p_desired_build is null
     or p_expected_build = p_desired_build
     or p_lease_id is null
     or p_ttl_seconds < 60 or p_ttl_seconds > 1800 then
    raise exception using errcode = '22023', message = 'invalid deployment lease input';
  end if;

  select * into v_state
  from deployment_state
  where singleton = true
  for update;

  if v_state.lease_id is not null
     and v_state.lease_id <> p_lease_id
     and v_state.lease_expires_at > v_now then
    return jsonb_build_object(
      'acquired', false,
      'reason', 'lease-busy',
      'currentBuild', v_state.current_build,
      'leaseExpiresAt', v_state.lease_expires_at
    );
  end if;

  if v_state.current_build <> p_expected_build then
    return jsonb_build_object(
      'acquired', false,
      'reason', 'version-mismatch',
      'currentBuild', v_state.current_build
    );
  end if;

  update deployment_state
  set pending_build = p_desired_build,
      lease_id = p_lease_id,
      lease_expires_at = v_now + make_interval(secs => p_ttl_seconds),
      updated_at = v_now
  where singleton = true;

  insert into deployment_events (
    event_type, expected_build, desired_build, lease_id
  ) values (
    'lease-acquired', p_expected_build, p_desired_build, p_lease_id
  );

  return jsonb_build_object(
    'acquired', true,
    'currentBuild', p_expected_build,
    'leaseExpiresAt', v_now + make_interval(secs => p_ttl_seconds)
  );
end;
$$;

create or replace function public.of_renew_deployment_lease(
  p_lease_id uuid,
  p_desired_build text,
  p_ttl_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_updated integer;
  v_expires timestamptz := clock_timestamp() + make_interval(secs => p_ttl_seconds);
begin
  if p_ttl_seconds < 60 or p_ttl_seconds > 1800 then
    raise exception using errcode = '22023', message = 'invalid deployment lease ttl';
  end if;
  update deployment_state
  set lease_expires_at = v_expires, updated_at = clock_timestamp()
  where singleton = true
    and lease_id = p_lease_id
    and pending_build = p_desired_build
    and lease_expires_at > clock_timestamp();
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception using errcode = '55000', message = 'deployment lease is not active';
  end if;
  insert into deployment_events (event_type, desired_build, lease_id)
  values ('lease-renewed', p_desired_build, p_lease_id);
  return jsonb_build_object('renewed', true, 'leaseExpiresAt', v_expires);
end;
$$;

create or replace function public.of_complete_deployment(
  p_lease_id uuid,
  p_desired_build text
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_updated integer;
begin
  update deployment_state
  set current_build = p_desired_build,
      pending_build = null,
      lease_id = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  where singleton = true
    and lease_id = p_lease_id
    and pending_build = p_desired_build
    and lease_expires_at > clock_timestamp();
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception using errcode = '55000', message = 'deployment lease is not active';
  end if;
  insert into deployment_events (event_type, desired_build, lease_id)
  values ('deployment-completed', p_desired_build, p_lease_id);
  return jsonb_build_object('completed', true, 'currentBuild', p_desired_build);
end;
$$;

create or replace function public.of_fail_deployment(
  p_lease_id uuid,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_state deployment_state%rowtype;
begin
  if p_reason_code !~ '^[a-z][a-z0-9-]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid failure reason';
  end if;
  select * into v_state
  from deployment_state
  where singleton = true and lease_id = p_lease_id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'deployment lease is not active';
  end if;
  update deployment_state
  set pending_build = null,
      lease_id = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  where singleton = true;
  insert into deployment_events (
    event_type, expected_build, desired_build, reason_code, lease_id
  ) values (
    'deployment-failed', v_state.current_build, v_state.pending_build,
    p_reason_code, p_lease_id
  );
  return jsonb_build_object('failed', true, 'currentBuild', v_state.current_build);
end;
$$;

revoke all on table one_fetch.deployment_state from public, anon, authenticated;
revoke all on table one_fetch.deployment_events from public, anon, authenticated;
revoke all on function public.of_acquire_deployment_lease(text, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.of_renew_deployment_lease(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.of_complete_deployment(uuid, text)
  from public, anon, authenticated;
revoke all on function public.of_fail_deployment(uuid, text)
  from public, anon, authenticated;
grant execute on function public.of_acquire_deployment_lease(text, text, uuid, integer)
  to service_role;
grant execute on function public.of_renew_deployment_lease(uuid, text, integer)
  to service_role;
grant execute on function public.of_complete_deployment(uuid, text)
  to service_role;
grant execute on function public.of_fail_deployment(uuid, text)
  to service_role;

-- one-fetch-self-checksum-v1: beffe86cc7796d33d13f0584e467be0cfe243629f45b1aa3f806c159a36141e0
insert into one_fetch.migration_history (version, checksum)
values ('202609040010', 'beffe86cc7796d33d13f0584e467be0cfe243629f45b1aa3f806c159a36141e0');

commit;
