begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

select has_schema('one_fetch', 'internal schema exists');
select has_table('one_fetch', 'instance_state', 'instance table exists');
select has_table('one_fetch', 'admins', 'admin table exists');
select has_table('one_fetch', 'sessions', 'session table exists');
select has_table('one_fetch', 'execution_tokens', 'execution token table exists');
select has_table('one_fetch', 'audit_events', 'audit table exists');
select has_table('one_fetch', 'execution_reports', 'short-term report table exists');
select has_table('one_fetch', 'quota_windows', 'quota table exists');
select has_function('public', 'of_bootstrap_admin', array['uuid','text','text','text','jsonb','jsonb'], 'bootstrap RPC exists');
select has_function('public', 'of_update_config', array['uuid','bigint','text','jsonb','text[]','jsonb'], 'config RPC exists');
select has_function('public', 'of_acquire_execution', array['uuid','text','text','bigint','integer'], 'quota RPC exists');
select has_function('public', 'of_get_execution_report', array['uuid','uuid'], 'report lookup binds the execution token');
select function_privs_are('public', 'of_get_instance_state', array[]::text[], 'service_role', array['EXECUTE'], 'service role can call state RPC');
select function_privs_are('public', 'of_get_instance_state', array[]::text[], 'anon', array[]::text[], 'anon cannot call state RPC');
select table_privs_are('one_fetch', 'admins', 'anon', array[]::text[], 'anon cannot read admins');
select table_privs_are('one_fetch', 'audit_events', 'authenticated', array[]::text[], 'authenticated cannot read audit');
select is((select count(*)::bigint from one_fetch.migration_history), 4::bigint, 'all migrations are recorded once');

select * from finish();
rollback;
