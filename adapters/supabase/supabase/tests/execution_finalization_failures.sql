begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

insert into one_fetch.instance_state (
  singleton, instance_id, initialized, config_version, active_config
) values (
  true, '71000000-0000-4000-8000-000000000001', true,
  'test-config-v1', '{}'::jsonb
);
insert into one_fetch.admins (id, username, password_hash)
values ('71000000-0000-4000-8000-000000000002', 'failures', 'test-hash');
insert into one_fetch.execution_tokens (
  id, name, token_hash, scopes, quotas, created_by
) values
  (
    '71000000-0000-4000-8000-000000000003', 'failures-primary',
    repeat('7', 64),
    '{"transports":["http"],"origins":["*"],"ports":[]}'::jsonb,
    '{"requestsPerMinute":60,"concurrentHttp":8,"concurrentTunnels":2,"bytesPerDay":1048576}'::jsonb,
    '71000000-0000-4000-8000-000000000002'
  ),
  (
    '71000000-0000-4000-8000-000000000007', 'failures-secondary',
    repeat('8', 64),
    '{"transports":["http"],"origins":["*"],"ports":[]}'::jsonb,
    '{"requestsPerMinute":60,"concurrentHttp":8,"concurrentTunnels":2,"bytesPerDay":1048576}'::jsonb,
    '71000000-0000-4000-8000-000000000002'
  );

create function pg_temp.acquire(p_request text)
returns uuid language plpgsql as $$
declare v_result jsonb;
begin
  v_result := public.of_acquire_execution(
    '71000000-0000-4000-8000-000000000003', p_request, 'http', 0, 60
  );
  if not coalesce((v_result ->> 'allowed')::boolean, false) then
    raise exception 'fixture lease acquisition failed: %', v_result;
  end if;
  return (v_result ->> 'leaseId')::uuid;
end;
$$;
create function pg_temp.report(p_report uuid, p_request text, p_bytes bigint)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schemaVersion', 1, 'reportId', p_report, 'requestId', p_request,
    'outcome', 'completed', 'source', 'target', 'status', 200,
    'responseBytes', p_bytes, 'bodyComplete', true,
    'timing', '{"phases":[],"serverTiming":[]}'::jsonb,
    'finishedAt', '2026-09-04T00:00:00.000Z', 'auditState', 'recorded'
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
  'binding', pg_temp.acquire('request-binding'),
  '71000000-0000-4000-8000-000000000009', 'request-binding'
);
select throws_ok(
  $$
    select public.of_finalize_execution(
      lease_id, 0, report_id, 'wrong-request',
      '71000000-0000-4000-8000-000000000003',
      'completed', pg_temp.report(report_id, 'wrong-request', 0),
      clock_timestamp() + interval '10 minutes',
      pg_temp.audit(gen_random_uuid(), 'wrong-request', report_id,
        '71000000-0000-4000-8000-000000000003'), false
    ) from lifecycle_leases where kind = 'binding'
  $$,
  '22023', 'execution_binding_mismatch',
  'request binding mismatch is rejected before audit or release'
);
select throws_ok(
  $$
    select public.of_finalize_execution(
      lease_id, 0, report_id, request_id,
      '71000000-0000-4000-8000-000000000007',
      'completed', pg_temp.report(report_id, request_id, 0),
      clock_timestamp() + interval '10 minutes',
      pg_temp.audit(gen_random_uuid(), request_id, report_id,
        '71000000-0000-4000-8000-000000000007'), false
    ) from lifecycle_leases where kind = 'binding'
  $$,
  '22023', 'execution_binding_mismatch',
  'token binding mismatch is rejected before audit or release'
);
select throws_ok(
  $$
    select public.of_finalize_execution(
      lease_id, -1, report_id, request_id,
      '71000000-0000-4000-8000-000000000003',
      'completed', pg_temp.report(report_id, request_id, -1),
      clock_timestamp() + interval '10 minutes',
      pg_temp.audit(gen_random_uuid(), request_id, report_id,
        '71000000-0000-4000-8000-000000000003'), false
    ) from lifecycle_leases where kind = 'binding'
  $$,
  '22023', 'execution_finalization_invalid',
  'negative response bytes are rejected'
);
select is(
  (select count(*)::bigint from one_fetch.execution_leases
   where request_id = 'request-binding'),
  1::bigint, 'invalid finalization leaves its lease intact'
);
select is(
  (select count(*)::bigint from one_fetch.execution_reports
   where report_id = '71000000-0000-4000-8000-000000000009'),
  0::bigint, 'invalid finalization creates no report'
);
select is(
  (select audit_degraded from one_fetch.instance_state where singleton),
  false, 'binding and validation errors are not audit degradation'
);
do $$
begin
  perform public.of_release_execution(
    (select lease_id from lifecycle_leases where kind = 'binding'), 0
  );
end;
$$;

insert into lifecycle_leases values (
  'storage', pg_temp.acquire('request-storage'),
  '71000000-0000-4000-8000-000000000010', 'request-storage'
);
create function pg_temp.fail_report_insert()
returns trigger language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = 'forced_report_failure';
end;
$$;
create trigger fail_report_insert
before insert on one_fetch.execution_reports
for each row execute function pg_temp.fail_report_insert();
select throws_ok(
  $$
    select public.of_finalize_execution(
      lease_id, 0, report_id, request_id,
      '71000000-0000-4000-8000-000000000003',
      'completed', pg_temp.report(report_id, request_id, 0),
      clock_timestamp() + interval '10 minutes',
      pg_temp.audit('71000000-0000-4000-8000-000000000011', request_id,
        report_id, '71000000-0000-4000-8000-000000000003'), false
    ) from lifecycle_leases where kind = 'storage'
  $$,
  'P0001', 'forced_report_failure',
  'report storage failure propagates instead of becoming audit degradation'
);
drop trigger fail_report_insert on one_fetch.execution_reports;
select is(
  (select audit_degraded from one_fetch.instance_state where singleton),
  false, 'report storage failure does not mark audit degraded'
);
select is(
  (select count(*)::bigint from one_fetch.execution_leases
   where request_id = 'request-storage'),
  1::bigint, 'report storage failure rolls back lease release'
);
select is(
  (select count(*)::bigint from one_fetch.audit_events
   where request_id = 'request-storage'),
  0::bigint, 'report storage failure rolls back terminal audit insertion'
);
select is(
  (select count(*)::bigint from one_fetch.execution_reports
   where report_id = '71000000-0000-4000-8000-000000000010'),
  0::bigint, 'report storage failure leaves no partial report'
);
do $$
begin
  perform public.of_release_execution(
    (select lease_id from lifecycle_leases where kind = 'storage'), 0
  );
end;
$$;

insert into lifecycle_leases values (
  'prior-degraded', pg_temp.acquire('request-prior-degraded'),
  '71000000-0000-4000-8000-000000000012', 'request-prior-degraded'
);
insert into lifecycle_results
select 'prior-degraded', public.of_finalize_execution(
  lease_id, 8, report_id, request_id,
  '71000000-0000-4000-8000-000000000003',
  'completed', pg_temp.report(report_id, request_id, 8),
  clock_timestamp() + interval '10 minutes',
  pg_temp.audit('71000000-0000-4000-8000-000000000013', request_id,
    report_id, '71000000-0000-4000-8000-000000000003'), true
) from lifecycle_leases where kind = 'prior-degraded';
select is(
  result ->> 'status', 'finalized',
  'prior degradation still permits terminal finalization'
) from lifecycle_results where kind = 'prior-degraded';
select is(result ->> 'auditState', 'degraded', 'prior degradation is retained')
from lifecycle_results where kind = 'prior-degraded';
select is(
  (select audit_degraded from one_fetch.instance_state where singleton),
  true, 'prior audit degradation is persisted globally'
);
select is(
  (select report ->> 'auditState' from one_fetch.execution_reports
   where request_id = 'request-prior-degraded'),
  'degraded', 'prior audit degradation is persisted in the report'
);
select is(
  (select count(*)::bigint from one_fetch.audit_events
   where request_id = 'request-prior-degraded'),
  1::bigint, 'terminal audit is still attempted after prior degradation'
);
select is(
  (select count(*)::bigint from one_fetch.execution_leases
   where request_id = 'request-prior-degraded'),
  0::bigint, 'prior-degraded finalization releases its lease'
);

insert into lifecycle_leases values (
  'missing-audit', pg_temp.acquire('request-missing-audit'),
  '71000000-0000-4000-8000-000000000016', 'request-missing-audit'
);
insert into lifecycle_results
select 'missing-audit', public.of_finalize_execution(
  lease_id, 2, report_id, request_id,
  '71000000-0000-4000-8000-000000000003',
  'completed', pg_temp.report(report_id, request_id, 2),
  clock_timestamp() + interval '10 minutes', null, true
) from lifecycle_leases where kind = 'missing-audit';
select is(
  result ->> 'status', 'finalized',
  'a missing audit event may finalize only after prior degradation'
) from lifecycle_results where kind = 'missing-audit';
select is(result ->> 'auditState', 'degraded', 'missing audit retains degradation')
from lifecycle_results where kind = 'missing-audit';
select is(
  (select report ->> 'auditState' from one_fetch.execution_reports
   where request_id = 'request-missing-audit'),
  'degraded', 'missing audit stores a degraded report'
);
select is(
  (select count(*)::bigint from one_fetch.audit_events
   where request_id = 'request-missing-audit'),
  0::bigint, 'missing audit does not manufacture an event'
);
select is(
  (select count(*)::bigint from one_fetch.execution_leases
   where request_id = 'request-missing-audit'),
  0::bigint, 'missing-audit finalization releases its lease'
);

update one_fetch.instance_state set audit_degraded = false where singleton;
insert into lifecycle_leases values (
  'audit-failure', pg_temp.acquire('request-audit-failure'),
  '71000000-0000-4000-8000-000000000014', 'request-audit-failure'
);
create function pg_temp.fail_audit_insert()
returns trigger language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = 'forced_audit_failure';
end;
$$;
create trigger fail_audit_insert
before insert on one_fetch.audit_events
for each row execute function pg_temp.fail_audit_insert();
insert into lifecycle_results
select 'audit-failure', public.of_finalize_execution(
  lease_id, 4, report_id, request_id,
  '71000000-0000-4000-8000-000000000003',
  'completed', pg_temp.report(report_id, request_id, 4),
  clock_timestamp() + interval '10 minutes',
  pg_temp.audit('71000000-0000-4000-8000-000000000015', request_id,
    report_id, '71000000-0000-4000-8000-000000000003'), false
) from lifecycle_leases where kind = 'audit-failure';
drop trigger fail_audit_insert on one_fetch.audit_events;
select is(
  result ->> 'status', 'finalized',
  'audit failure still produces a terminal result'
) from lifecycle_results where kind = 'audit-failure';
select is(result ->> 'auditState', 'degraded', 'audit failure is distinguished')
from lifecycle_results where kind = 'audit-failure';
select is(
  (select audit_degraded from one_fetch.instance_state where singleton),
  true, 'audit insertion failure persists the degradation marker'
);
select is(
  (select report ->> 'auditState' from one_fetch.execution_reports
   where request_id = 'request-audit-failure'),
  'degraded', 'audit insertion failure stores a degraded report'
);
select is(
  (select count(*)::bigint from one_fetch.audit_events
   where request_id = 'request-audit-failure'),
  0::bigint, 'failed terminal audit leaves no partial audit row'
);
select is(
  (select count(*)::bigint from one_fetch.execution_leases
   where request_id = 'request-audit-failure'),
  0::bigint, 'audit-degraded finalization still releases its lease'
);
select is(
  (select response_bytes from one_fetch.quota_windows
   where execution_token_id = '71000000-0000-4000-8000-000000000003'
     and bucket_kind = 'day'),
  14::bigint, 'successful terminal writes account response bytes exactly once'
);

select * from finish();
rollback;
