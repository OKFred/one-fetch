begin;

create or replace function public.of_get_active_config()
returns jsonb
language sql
stable
security definer
set search_path = one_fetch, pg_temp
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'instanceId', instance_id,
        'initialized', initialized,
        'gatewayPaused', gateway_paused,
        'revision', config_revision,
        'version', config_version,
        'config', active_config,
        'updatedAt', updated_at
      )
      from instance_state
      where singleton
    ),
    '{"initialized":false}'::jsonb
  );
$$;

create or replace function public.of_update_config(
  p_admin_id uuid,
  p_expected_revision bigint,
  p_version text,
  p_config jsonb,
  p_changed_fields text[],
  p_audit jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_current bigint;
  v_hash text;
begin
  select config_revision into v_current
  from instance_state
  where singleton and initialized
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'instance_not_initialized';
  end if;
  if v_current <> p_expected_revision then
    raise exception using errcode = '40001', message = 'config_revision_conflict';
  end if;

  v_hash := encode(extensions.digest(convert_to(p_config::text, 'UTF8'), 'sha256'), 'hex');
  insert into config_revisions (
    revision,
    version,
    config,
    config_hash,
    changed_fields,
    changed_by
  ) values (
    v_current + 1,
    p_version,
    p_config,
    v_hash,
    coalesce(p_changed_fields, '{}'),
    p_admin_id
  );

  update instance_state
  set config_revision = v_current + 1,
      config_version = p_version,
      active_config = p_config,
      gateway_paused = coalesce((p_config ->> 'gatewayPaused')::boolean, gateway_paused),
      updated_at = clock_timestamp()
  where singleton;

  perform append_audit(p_audit);
  return jsonb_build_object(
    'revision', v_current + 1,
    'version', p_version,
    'configHash', v_hash
  );
end;
$$;

create or replace function public.of_append_audit(p_event jsonb)
returns uuid
language sql
security definer
set search_path = one_fetch, pg_temp
as $$
  select append_audit(p_event);
$$;

create or replace function public.of_list_audit(
  p_before_sequence bigint default null,
  p_limit integer default 100,
  p_category text default null,
  p_request_id text default null
)
returns setof jsonb
language sql
stable
security definer
set search_path = one_fetch, pg_temp
as $$
  select jsonb_build_object(
    'sequence', sequence,
    'eventId', event_id,
    'occurredAt', occurred_at,
    'recordedAt', recorded_at,
    'category', category,
    'action', action,
    'outcome', outcome,
    'severity', severity,
    'actorType', actor_type,
    'actorId', actor_id,
    'requestId', request_id,
    'reportId', report_id,
    'connectionId', connection_id,
    'configVersion', config_version,
    'payload', payload,
    'payloadHash', payload_hash,
    'signature', signature,
    'keyId', key_id
  )
  from audit_events
  where (p_before_sequence is null or sequence < p_before_sequence)
    and (p_category is null or category = p_category)
    and (p_request_id is null or request_id = p_request_id)
  order by sequence desc
  limit least(greatest(p_limit, 1), 500);
$$;

create or replace function public.of_put_execution_report(
  p_report_id uuid,
  p_request_id text,
  p_token_id uuid,
  p_outcome text,
  p_report jsonb,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
begin
  insert into execution_reports (
    report_id,
    request_id,
    execution_token_id,
    outcome,
    report,
    expires_at
  ) values (
    p_report_id,
    p_request_id,
    p_token_id,
    p_outcome,
    p_report,
    p_expires_at
  ) on conflict (report_id) do update
    set outcome = excluded.outcome,
        report = excluded.report,
        expires_at = excluded.expires_at;
  return true;
end;
$$;

create or replace function public.of_get_execution_report(
  p_report_id uuid,
  p_token_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = one_fetch, pg_temp
as $$
  select coalesce(
    (
      select report
      from execution_reports
      where report_id = p_report_id
        and execution_token_id = p_token_id
        and expires_at > clock_timestamp()
    ),
    'null'::jsonb
  );
$$;
revoke all on function public.of_get_active_config() from public, anon, authenticated;
grant execute on function public.of_get_active_config() to service_role;
revoke all on function public.of_update_config(uuid, bigint, text, jsonb, text[], jsonb) from public, anon, authenticated;
grant execute on function public.of_update_config(uuid, bigint, text, jsonb, text[], jsonb) to service_role;
revoke all on function public.of_append_audit(jsonb) from public, anon, authenticated;
grant execute on function public.of_append_audit(jsonb) to service_role;
revoke all on function public.of_list_audit(bigint, integer, text, text) from public, anon, authenticated;
grant execute on function public.of_list_audit(bigint, integer, text, text) to service_role;
revoke all on function public.of_put_execution_report(uuid, text, uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.of_put_execution_report(uuid, text, uuid, text, jsonb, timestamptz) to service_role;
revoke all on function public.of_get_execution_report(uuid, uuid) from public, anon, authenticated;
grant execute on function public.of_get_execution_report(uuid, uuid) to service_role;

-- one-fetch-self-checksum-v1: e1b544260fdecf4194c61b74c400ace390019ff1444d451745d4caf9f66e043b
insert into one_fetch.migration_history (version, checksum)
values ('202609040003', 'e1b544260fdecf4194c61b74c400ace390019ff1444d451745d4caf9f66e043b');

commit;
