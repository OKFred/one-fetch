begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

select is(
  (public.of_acquire_deployment_lease(
    'none', '0.1.0+supabase.g111111111111',
    '11111111-1111-4111-8111-111111111111', 300
  ) ->> 'acquired')::boolean,
  true,
  'the expected build acquires a deployment lease'
);

select is(
  public.of_acquire_deployment_lease(
    'none', '0.1.0+supabase.g222222222222',
    '22222222-2222-4222-8222-222222222222', 300
  ) ->> 'reason',
  'lease-busy',
  'a concurrent deployment cannot steal an active lease'
);

select is(
  (public.of_renew_deployment_lease(
    '11111111-1111-4111-8111-111111111111',
    '0.1.0+supabase.g111111111111', 300
  ) ->> 'renewed')::boolean,
  true,
  'the lease owner can renew its lease'
);

select is(
  (public.of_complete_deployment(
    '11111111-1111-4111-8111-111111111111',
    '0.1.0+supabase.g111111111111'
  ) ->> 'completed')::boolean,
  true,
  'the lease owner completes the deployment'
);

select is(
  (select current_build from one_fetch.deployment_state where singleton),
  '0.1.0+supabase.g111111111111',
  'completion atomically advances the current build'
);

select is(
  public.of_acquire_deployment_lease(
    'none', '0.1.0+supabase.g222222222222',
    '22222222-2222-4222-8222-222222222222', 300
  ) ->> 'reason',
  'version-mismatch',
  'a stale expected build is rejected'
);

select is(
  (public.of_acquire_deployment_lease(
    '0.1.0+supabase.g111111111111', '0.1.0+supabase.g222222222222',
    '22222222-2222-4222-8222-222222222222', 300
  ) ->> 'acquired')::boolean,
  true,
  'the current build can start an update'
);

select is(
  (public.of_fail_deployment(
    '22222222-2222-4222-8222-222222222222', 'function-deploy-failed'
  ) ->> 'failed')::boolean,
  true,
  'a failed deployment releases its lease'
);

select is(
  (select current_build from one_fetch.deployment_state where singleton),
  '0.1.0+supabase.g111111111111',
  'failure does not change the current build'
);

select is(
  (select count(*)::integer from one_fetch.deployment_events),
  5,
  'lease lifecycle events are recorded'
);

select * from finish();
rollback;
