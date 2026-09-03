begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

insert into one_fetch.instance_state (
  singleton, instance_id, initialized, config_version, active_config
) values (
  true, '70000000-0000-4000-8000-000000000001', true,
  'test-config-v1', '{}'::jsonb
);
insert into one_fetch.admins (id, username, password_hash)
values ('70000000-0000-4000-8000-000000000002', 'lifecycle', 'test-hash');
insert into one_fetch.execution_tokens (
  id, name, token_hash, scopes, quotas, created_by
) values
  (
    '70000000-0000-4000-8000-000000000003', 'lifecycle-primary',
    repeat('7', 64),
    '{"transports":["http"],"origins":["*"],"ports":[]}'::jsonb,
    '{"requestsPerMinute":60,"concurrentHttp":8,"concurrentTunnels":2,"bytesPerDay":1048576}'::jsonb,
    '70000000-0000-4000-8000-000000000002'
  ),
  (
    '70000000-0000-4000-8000-000000000007', 'lifecycle-secondary',
    repeat('8', 64),
    '{"transports":["http"],"origins":["*"],"ports":[]}'::jsonb,
    '{"requestsPerMinute":60,"concurrentHttp":8,"concurrentTunnels":2,"bytesPerDay":1048576}'::jsonb,
    '70000000-0000-4000-8000-000000000002'
  );

create function pg_temp.acquire(p_token uuid, p_request text)
returns uuid language plpgsql as $$
declare v_result jsonb;
begin
  v_result := public.of_acquire_execution(p_token, p_request, 'http', 0, 60);
  if not coalesce((v_result ->> 'allowed')::boolean, false) then
    raise exception 'fixture lease acquisition failed: %', v_result;
  end if;
  return (v_result ->> 'leaseId')::uuid;
end;
$$;
create function pg_temp.report(
  p_report uuid, p_request text, p_bytes bigint, p_marker text default 'base'
)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schemaVersion', 1, 'reportId', p_report, 'requestId', p_request,
    'outcome', 'completed', 'source', 'target', 'status', 200,
    'responseBytes', p_bytes, 'bodyComplete', true,
    'timing', '{"phases":[],"serverTiming":[]}'::jsonb,
    'finishedAt', '2026-09-04T00:00:00.000Z',
    'auditState', 'recorded', 'marker', p_marker
  );
$$;
create function pg_temp.audit(
  p_event uuid, p_request text, p_report uuid, p_token uuid
)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'eventId', p_event, 'occurredAt', clock_timestamp(),
    'category', 'execution', 'action', 'execution.completed',
    'outcome', 'success', 'severity', 'info',
    'actor', jsonb_build_object('type', 'execution-token', 'actorId', p_token),
    'correlation', jsonb_build_object('requestId', p_request, 'reportId', p_report),
    'integrity', jsonb_build_object(
      'payloadHash', repeat('a', 64), 'signature', 'test-signature',
      'keyId', 'test-key'
    )
  );
$$;

create temporary table lifecycle_leases (
  kind text primary key, lease_id uuid not null,
  report_id uuid not null, request_id text not null
);
create temporary table lifecycle_results (
  kind text primary key, result jsonb not null
);
insert into lifecycle_leases values (
  'normal',
  pg_temp.acquire('70000000-0000-4000-8000-000000000003', 'request-normal'),
  '70000000-0000-4000-8000-000000000004', 'request-normal'
);

select ok(
  (select lease_id is not null from lifecycle_leases where kind = 'normal'),
  'normal execution acquires a lease'
);
select is(
  (
    select count(*)::bigint
    from one_fetch.execution_leases leases
    join one_fetch.quota_windows windows
      on windows.execution_token_id = leases.execution_token_id
    where leases.request_id = 'request-normal'
      and (
        (windows.bucket_kind = 'minute'
          and windows.bucket_start = date_trunc('minute', leases.acquired_at))
        or (windows.bucket_kind = 'day'
          and windows.bucket_start = date_trunc('day', leases.acquired_at))
      )
  ), 2::bigint,
  'lease and quota buckets share one acquisition timestamp'
);
select is(
  public.of_reconcile_execution_request(
    (select lease_id from lifecycle_leases where kind = 'normal'), null
  ) ->> 'reason',
  'lease_invalid', 'null request bytes are rejected'
);
select is(
  (public.of_reconcile_execution_request(
    (select lease_id from lifecycle_leases where kind = 'normal'), 128
  ) ->> 'allowed')::boolean,
  true, 'zero request bytes reconcile to the observed value'
);
select is(
  (select request_bytes from one_fetch.execution_leases
   where request_id = 'request-normal'),
  128::bigint, 'lease records reconciled request bytes'
);
select is(
  (select request_bytes from one_fetch.quota_windows
   where execution_token_id = '70000000-0000-4000-8000-000000000003'
     and bucket_kind = 'minute'),
  128::bigint, 'minute quota records reconciled bytes'
);
select is(
  (select request_bytes from one_fetch.quota_windows
   where execution_token_id = '70000000-0000-4000-8000-000000000003'
     and bucket_kind = 'day'),
  128::bigint, 'daily quota records reconciled bytes'
);
select is(
  (public.of_reconcile_execution_request(
    (select lease_id from lifecycle_leases where kind = 'normal'), 128
  ) ->> 'allowed')::boolean,
  true, 'same-value reconciliation is idempotent'
);
select is(
  (select request_bytes from one_fetch.quota_windows
   where execution_token_id = '70000000-0000-4000-8000-000000000003'
     and bucket_kind = 'minute'),
  128::bigint, 'idempotent reconciliation does not double count minute bytes'
);
select is(
  (select request_bytes from one_fetch.quota_windows
   where execution_token_id = '70000000-0000-4000-8000-000000000003'
     and bucket_kind = 'day'),
  128::bigint, 'idempotent reconciliation does not double count daily bytes'
);
select is(
  public.of_reconcile_execution_request(
    (select lease_id from lifecycle_leases where kind = 'normal'), 127
  ) ->> 'reason',
  'request_bytes_conflict', 'a different second reconciliation is rejected'
);
select is(
  (select request_bytes from one_fetch.quota_windows
   where execution_token_id = '70000000-0000-4000-8000-000000000003'
     and bucket_kind = 'day'),
  128::bigint, 'conflicting reconciliation cannot lower counted bytes'
);

insert into lifecycle_leases values (
  'quota-missing',
  pg_temp.acquire('70000000-0000-4000-8000-000000000007', 'quota-missing'),
  '70000000-0000-4000-8000-000000000008', 'quota-missing'
);
delete from one_fetch.quota_windows
where execution_token_id = '70000000-0000-4000-8000-000000000007'
  and bucket_kind = 'minute';
select is(
  public.of_reconcile_execution_request(
    (select lease_id from lifecycle_leases where kind = 'quota-missing'), 16
  ) ->> 'reason',
  'quota_state_invalid',
  'reconciliation fails closed when either quota bucket is missing'
);
do $$
begin
  perform public.of_release_execution(
    (select lease_id from lifecycle_leases where kind = 'quota-missing'), 0
  );
end;
$$;

insert into lifecycle_results
select 'normal', public.of_finalize_execution(
  lease_id, 64, report_id, request_id,
  '70000000-0000-4000-8000-000000000003',
  'completed', pg_temp.report(report_id, request_id, 64),
  clock_timestamp() + interval '10 minutes',
  pg_temp.audit(
    '70000000-0000-4000-8000-000000000005', request_id, report_id,
    '70000000-0000-4000-8000-000000000003'
  ), false
) from lifecycle_leases where kind = 'normal';
select is(result ->> 'status', 'finalized', 'first finalization is distinguished')
from lifecycle_results where kind = 'normal';
select is(result ->> 'auditState', 'recorded', 'successful audit is reported')
from lifecycle_results where kind = 'normal';
select is(
  (select count(*)::bigint from one_fetch.execution_leases
   where request_id = 'request-normal'),
  0::bigint, 'first finalization releases the lease'
);
select ok(
  (
    select lease_id = (select lease_id from lifecycle_leases where kind = 'normal')
      and report ->> 'auditState' = 'recorded'
    from one_fetch.execution_reports where request_id = 'request-normal'
  ),
  'report retains its lease identity and recorded audit state'
);
select is(
  (select count(*)::bigint from one_fetch.audit_events
   where request_id = 'request-normal'),
  1::bigint, 'first finalization stores one terminal audit event'
);
select is(
  (select response_bytes from one_fetch.quota_windows
   where execution_token_id = '70000000-0000-4000-8000-000000000003'
     and bucket_kind = 'day'),
  64::bigint, 'first finalization accounts response bytes'
);
select is(
  (select audit_degraded from one_fetch.instance_state where singleton),
  false, 'healthy finalization does not mark audit degraded'
);

insert into lifecycle_results
select 'normal-retry', public.of_finalize_execution(
  lease_id, 64, report_id, request_id,
  '70000000-0000-4000-8000-000000000003',
  'completed', pg_temp.report(report_id, request_id, 64),
  clock_timestamp() + interval '20 minutes',
  pg_temp.audit(
    '70000000-0000-4000-8000-000000000006', request_id, report_id,
    '70000000-0000-4000-8000-000000000003'
  ), false
) from lifecycle_leases where kind = 'normal';
select is(
  result ->> 'status', 'already_finalized',
  'lost-ack retry is distinguished from first finalization'
) from lifecycle_results where kind = 'normal-retry';
select is(result ->> 'auditState', 'recorded', 'retry returns persisted audit state')
from lifecycle_results where kind = 'normal-retry';
select is(
  (select count(*)::bigint from one_fetch.audit_events
   where request_id = 'request-normal'),
  1::bigint, 'idempotent retry cannot append a second audit event'
);
select is(
  (select response_bytes from one_fetch.quota_windows
   where execution_token_id = '70000000-0000-4000-8000-000000000003'
     and bucket_kind = 'day'),
  64::bigint, 'idempotent retry cannot count response bytes twice'
);
select throws_ok(
  $$
    select public.of_finalize_execution(
      lease_id, 64, report_id, request_id,
      '70000000-0000-4000-8000-000000000003',
      'completed', pg_temp.report(report_id, request_id, 64, 'changed'),
      clock_timestamp() + interval '10 minutes',
      pg_temp.audit(gen_random_uuid(), request_id, report_id,
        '70000000-0000-4000-8000-000000000003'), false
    ) from lifecycle_leases where kind = 'normal'
  $$,
  'P0001', 'execution_finalization_conflict',
  'a conflicting retry is rejected explicitly'
);
select is(
  (select report ->> 'marker' from one_fetch.execution_reports
   where request_id = 'request-normal'),
  'base', 'conflicting retry cannot change the persisted report'
);

select * from finish();
rollback;
