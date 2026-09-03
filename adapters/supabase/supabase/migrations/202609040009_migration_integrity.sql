begin;

create or replace function public.of_get_migration_integrity()
returns jsonb
language sql
stable
security definer
set search_path = one_fetch, pg_temp
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object('version', version, 'checksum', checksum)
    order by version
  ), '[]'::jsonb)
  from migration_history;
$$;

revoke all on function public.of_get_migration_integrity()
  from public, anon, authenticated;
grant execute on function public.of_get_migration_integrity() to service_role;

-- one-fetch-self-checksum-v1: 7d9ac8e564fcf7fd3d931387a1284d543830aa6c8d0174ce8d4c36de4adc7c31
insert into one_fetch.migration_history (version, checksum)
values ('202609040009', '7d9ac8e564fcf7fd3d931387a1284d543830aa6c8d0174ce8d4c36de4adc7c31');

commit;
