begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

create function pg_temp.audit_event(p_action text, p_outcome text)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'eventId', gen_random_uuid(),
    'occurredAt', clock_timestamp(),
    'recordedAt', clock_timestamp(),
    'category', 'auth',
    'action', p_action,
    'outcome', p_outcome,
    'severity', 'warning',
    'actor', jsonb_build_object('type', 'anonymous'),
    'correlation', '{}'::jsonb,
    'integrity', jsonb_build_object(
      'payloadHash', repeat('a', 64),
      'signature', 'test-signature',
      'keyId', 'test-key'
    )
  );
$$;

create function pg_temp.reject_audit()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_write_blocked';
end;
$$;

create trigger reject_audit_insert
before insert on one_fetch.audit_events
for each row execute function pg_temp.reject_audit();

select throws_ok(
  $sql$
    select public.of_bootstrap_admin_session(
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003',
      'administrator', 'password-hash', 'config-v1', '{}'::jsonb,
      '20000000-0000-4000-8000-000000000004',
      repeat('a', 64), repeat('b', 64),
      clock_timestamp() + interval '15 minutes',
      clock_timestamp() + interval '30 days', '', '',
      pg_temp.audit_event('account.bootstrap', 'success'),
      pg_temp.audit_event('auth.bootstrap.session', 'success'),
      pg_temp.audit_event('account.bootstrap.failure', 'failure')
    )
  $sql$,
  'P0001',
  'audit_write_blocked',
  'an audit failure aborts the whole bootstrap transaction'
);
select is((select count(*)::bigint from one_fetch.admins), 0::bigint, 'failed bootstrap leaves no admin');
select is((select count(*)::bigint from one_fetch.sessions), 0::bigint, 'failed bootstrap leaves no session');
select is((select count(*)::bigint from one_fetch.instance_state), 0::bigint, 'failed bootstrap is not consumed');

drop trigger reject_audit_insert on one_fetch.audit_events;

insert into one_fetch.instance_state (
  singleton, instance_id, initialized, config_version, active_config
) values (
  true, '20000000-0000-4000-8000-000000000099', false, 'stale', '{}'::jsonb
);
create temporary table mismatched_bootstrap as
select public.of_bootstrap_admin_session(
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
  'administrator', 'password-hash', 'config-v1', '{}'::jsonb,
  '20000000-0000-4000-8000-000000000004',
  repeat('a', 64), repeat('b', 64),
  clock_timestamp() + interval '15 minutes',
  clock_timestamp() + interval '30 days', '', '',
  pg_temp.audit_event('account.bootstrap', 'success'),
  pg_temp.audit_event('auth.bootstrap.session', 'success'),
  pg_temp.audit_event('account.bootstrap.failure', 'failure')
) as value;
select is(
  (select value ->> 'status' from mismatched_bootstrap),
  'already_initialized',
  'bootstrap rejects a mismatched stored instance'
);
select is(
  (select count(*)::bigint from one_fetch.admins),
  0::bigint,
  'mismatched bootstrap creates no administrator'
);
delete from one_fetch.instance_state;
delete from one_fetch.audit_events;

create temporary table bootstrap_result as
select public.of_bootstrap_admin_session(
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
  'administrator', 'password-hash', 'config-v1', '{}'::jsonb,
  '20000000-0000-4000-8000-000000000004',
  repeat('a', 64), repeat('b', 64),
  clock_timestamp() + interval '15 minutes',
  clock_timestamp() + interval '30 days', '', '',
  pg_temp.audit_event('account.bootstrap', 'success'),
  pg_temp.audit_event('auth.bootstrap.session', 'success'),
  pg_temp.audit_event('account.bootstrap.failure', 'failure')
) as value;

select is((select value ->> 'status' from bootstrap_result), 'created', 'bootstrap creates the instance');
select is((select count(*)::bigint from one_fetch.admins), 1::bigint, 'bootstrap creates one admin');
select is((select count(*)::bigint from one_fetch.sessions), 1::bigint, 'bootstrap creates one session');
select is((select count(*)::bigint from one_fetch.config_revisions), 1::bigint, 'bootstrap creates one configuration');
select is((select count(*)::bigint from one_fetch.audit_events), 2::bigint, 'bootstrap commits both audit events');

create temporary table repeated_bootstrap as
select public.of_bootstrap_admin_session(
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000012',
  '20000000-0000-4000-8000-000000000013',
  'other-admin', 'other-hash', 'config-v2', '{}'::jsonb,
  '20000000-0000-4000-8000-000000000014',
  repeat('c', 64), repeat('d', 64),
  clock_timestamp() + interval '15 minutes',
  clock_timestamp() + interval '30 days', '', '',
  pg_temp.audit_event('account.bootstrap', 'success'),
  pg_temp.audit_event('auth.bootstrap.session', 'success'),
  pg_temp.audit_event('account.bootstrap.failure', 'failure')
) as value;

select is((select value ->> 'status' from repeated_bootstrap), 'already_initialized', 'repeat bootstrap is generic');
select is((select count(*)::bigint from one_fetch.admins), 1::bigint, 'repeat bootstrap creates no admin');
select is((select count(*)::bigint from one_fetch.sessions), 1::bigint, 'repeat bootstrap creates no session');
select is((select count(*)::bigint from one_fetch.audit_events), 3::bigint, 'repeat bootstrap denial is audited');

create temporary table refresh_rotation as
select public.of_rotate_refresh_audited(
  repeat('b', 64), repeat('c', 64), repeat('d', 64),
  clock_timestamp() + interval '15 minutes',
  clock_timestamp() + interval '30 days',
  pg_temp.audit_event('auth.refresh', 'success'),
  pg_temp.audit_event('auth.refresh.reuse', 'denied'),
  pg_temp.audit_event('auth.refresh.failure', 'failure')
) as value;
select is(
  (select value ->> 'status' from refresh_rotation),
  'rotated',
  'the first refresh token use rotates the session'
);
create temporary table refresh_reuse as
select public.of_rotate_refresh_audited(
  repeat('b', 64), repeat('e', 64), repeat('f', 64),
  clock_timestamp() + interval '15 minutes',
  clock_timestamp() + interval '30 days',
  pg_temp.audit_event('auth.refresh', 'success'),
  pg_temp.audit_event('auth.refresh.reuse', 'denied'),
  pg_temp.audit_event('auth.refresh.failure', 'failure')
) as value;
select is(
  (select value ->> 'status' from refresh_reuse),
  'reuse',
  'a concurrent or replayed old refresh token is reuse'
);
select ok(
  (select revoked_at is not null from one_fetch.sessions where id = '20000000-0000-4000-8000-000000000003'),
  'refresh reuse revokes the whole session family'
);
select is(
  (select count(*)::bigint from one_fetch.audit_events where payload ->> 'action' in ('auth.refresh', 'auth.refresh.reuse')),
  2::bigint,
  'refresh rotation and reuse are both audited'
);

select is(
  (
    select bool_and((public.of_begin_login_attempt(
      repeat('e', 64), repeat('f', 64),
      pg_temp.audit_event('auth.login.throttled', 'denied')
    ) ->> 'allowed')::boolean)
    from generate_series(1, 10)
  ),
  true,
  'the username throttle permits its initial window'
);
select is(
  (public.of_begin_login_attempt(
    repeat('e', 64), repeat('f', 64),
    pg_temp.audit_event('auth.login.throttled', 'denied')
  ) ->> 'allowed')::boolean,
  false,
  'the username throttle denies attempt eleven'
);
create temporary table blocked_snapshot as
select blocked_until from one_fetch.login_throttles
where kind = 'login-username' and key_hash = repeat('e', 64);
select is(
  (public.of_begin_login_attempt(
    repeat('e', 64), repeat('f', 64),
    pg_temp.audit_event('auth.login.throttled', 'denied')
  ) ->> 'allowed')::boolean,
  false,
  'a blocked login remains denied'
);
select is(
  (select blocked_until from one_fetch.login_throttles where kind = 'login-username' and key_hash = repeat('e', 64)),
  (select blocked_until from blocked_snapshot),
  'blocked attempts do not extend the lock window'
);
do $$
begin
  for i in 1..30 loop
    perform public.of_begin_login_attempt(
      repeat('e', 64), repeat('f', 64),
      pg_temp.audit_event('auth.login.throttled', 'denied')
    );
  end loop;
end;
$$;
create temporary table blocked_audit_snapshot as
select count(*)::bigint as count from one_fetch.audit_events;
do $$
begin
  for i in 1..1000 loop
    perform public.of_begin_login_attempt(
      repeat('e', 64), repeat('f', 64),
      pg_temp.audit_event('auth.login.throttled', 'denied')
    );
  end loop;
end;
$$;
select is(
  (select count(*)::bigint from one_fetch.audit_events),
  (select count from blocked_audit_snapshot),
  'already-blocked requests do not amplify audit storage'
);

select ok(
  (public.of_begin_auth_source_attempt(
    'bootstrap-source', repeat('1', 64), 1,
    pg_temp.audit_event('auth.bootstrap.throttled', 'denied')
  ) ->> 'allowed')::boolean,
  'bootstrap source throttle permits its initial window'
);
select is(
  (public.of_begin_auth_source_attempt(
    'bootstrap-source', repeat('1', 64), 1,
    pg_temp.audit_event('auth.bootstrap.throttled', 'denied')
  ) ->> 'allowed')::boolean,
  false,
  'bootstrap source throttle blocks excess attempts'
);
select ok(
  (public.of_begin_auth_source_attempt(
    'refresh-source', repeat('2', 64), 1,
    pg_temp.audit_event('auth.refresh.throttled', 'denied')
  ) ->> 'allowed')::boolean,
  'refresh source throttle permits its initial window'
);
select is(
  (public.of_begin_auth_source_attempt(
    'refresh-source', repeat('2', 64), 1,
    pg_temp.audit_event('auth.refresh.throttled', 'denied')
  ) ->> 'allowed')::boolean,
  false,
  'refresh source throttle blocks excess attempts'
);

select ok(
  public.of_mark_audit_degraded(pg_temp.audit_event('audit.integrity.failure', 'failure')),
  'the first integrity failure marks audit degraded'
);
select ok((select audit_degraded from one_fetch.instance_state where singleton), 'audit degradation persists');
select is(
  public.of_mark_audit_degraded(pg_temp.audit_event('audit.integrity.failure', 'failure')),
  false,
  'repeated integrity failures do not append duplicate state events'
);
select is(
  (
    select count(*)::bigint
    from one_fetch.audit_events
    where payload ->> 'action' = 'audit.integrity.failure'
  ),
  1::bigint,
  'only one degradation event is appended'
);
select ok(
  (public.of_get_control_runtime_state() -> 'migrations') @>
    '[{"version":"202609040008"}]'::jsonb,
  'runtime state exposes migration 008'
);

select * from finish();
rollback;
