begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into one_fetch.admins (id, username, password_hash)
values (
  '10000000-0000-4000-8000-000000000001',
  'login-safety',
  'current-password-hash'
);

select is(
  public.of_issue_session(
    '10000000-0000-4000-8000-000000000001',
    'stale-password-hash',
    false,
    '10000000-0000-4000-8000-000000000002',
    repeat('a', 64),
    repeat('b', 64),
    clock_timestamp() + interval '15 minutes',
    clock_timestamp() + interval '30 days',
    '',
    '',
    '{}'::jsonb
  ),
  'null'::jsonb,
  'a stale password verification cannot issue a session'
);
select is(
  (select count(*)::bigint from one_fetch.sessions),
  0::bigint,
  'the stale verification created no session'
);

update one_fetch.admins
set locked_until = clock_timestamp() + interval '15 minutes',
    failed_login_count = 5
where id = '10000000-0000-4000-8000-000000000001';

select is(
  public.of_issue_session(
    '10000000-0000-4000-8000-000000000001',
    'current-password-hash',
    false,
    '10000000-0000-4000-8000-000000000003',
    repeat('c', 64),
    repeat('d', 64),
    clock_timestamp() + interval '15 minutes',
    clock_timestamp() + interval '30 days',
    '',
    '',
    '{}'::jsonb
  ),
  'null'::jsonb,
  'a locked administrator cannot issue a session'
);

create temporary table lock_snapshot as
select locked_until
from one_fetch.admins
where id = '10000000-0000-4000-8000-000000000001';

select public.of_record_login_failure(
  '10000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'eventId', gen_random_uuid(),
    'occurredAt', clock_timestamp(),
    'category', 'auth',
    'action', 'auth.locked',
    'outcome', 'failure',
    'severity', 'warning',
    'actor', jsonb_build_object('type', 'anonymous'),
    'correlation', '{}'::jsonb,
    'integrity', jsonb_build_object(
      'payloadHash', repeat('e', 64),
      'signature', 'test-signature',
      'keyId', 'test-key'
    )
  )
);
select is(
  (
    select admins.locked_until
    from one_fetch.admins admins, lock_snapshot snapshot
    where admins.id = '10000000-0000-4000-8000-000000000001'
      and admins.locked_until = snapshot.locked_until
  ),
  (select locked_until from lock_snapshot),
  'locked login attempts do not extend the lock window'
);

select * from finish();
rollback;
