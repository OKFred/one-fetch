begin;

create or replace function public.of_list_sessions(
  p_admin_id uuid,
  p_current_session_id uuid
)
returns setof jsonb
language sql
stable
security definer
set search_path = one_fetch, pg_temp
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 1,
    'id', id,
    'createdAt', created_at,
    'lastSeenAt', coalesce(last_seen_at, created_at),
    'expiresAt', refresh_expires_at,
    'current', id = p_current_session_id,
    'deviceFingerprint', device_label
  ))
  from sessions
  where admin_id = p_admin_id
    and revoked_at is null
    and refresh_expires_at > clock_timestamp()
  order by created_at desc;
$$;

create or replace function public.of_revoke_session(
  p_admin_id uuid,
  p_session_id uuid,
  p_reason text,
  p_audit jsonb
)
returns boolean
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_updated integer;
begin
  update sessions
  set revoked_at = clock_timestamp(),
      revoke_reason = left(p_reason, 120)
  where id = p_session_id
    and admin_id = p_admin_id
    and revoked_at is null;
  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    perform append_audit(p_audit);
  end if;
  return v_updated > 0;
end;
$$;

create or replace function public.of_get_admin_for_password_change(
  p_admin_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = one_fetch, pg_temp
as $$
  select coalesce(
    (
      select jsonb_build_object('passwordHash', password_hash)
      from admins
      where id = p_admin_id
    ),
    'null'::jsonb
  );
$$;

create or replace function public.of_change_password(
  p_admin_id uuid,
  p_current_session_id uuid,
  p_current_password_hash text,
  p_new_password_hash text,
  p_audit jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_actual_hash text;
  v_changed_at timestamptz := clock_timestamp();
  v_revoked_ids uuid[];
begin
  select password_hash into v_actual_hash
  from admins
  where id = p_admin_id
  for update;

  if not found or v_actual_hash <> p_current_password_hash then
    return 'null'::jsonb;
  end if;

  select coalesce(array_agg(id order by created_at), '{}'::uuid[])
  into v_revoked_ids
  from sessions
  where admin_id = p_admin_id
    and id <> p_current_session_id
    and revoked_at is null;

  update admins
  set password_hash = p_new_password_hash,
      updated_at = v_changed_at
  where id = p_admin_id;

  update sessions
  set revoked_at = v_changed_at,
      revoke_reason = 'password_changed'
  where admin_id = p_admin_id
    and id <> p_current_session_id
    and revoked_at is null;

  perform append_audit(p_audit);
  return jsonb_build_object(
    'schemaVersion', 1,
    'changedAt', v_changed_at,
    'revokedSessionIds', to_jsonb(v_revoked_ids)
  );
end;
$$;

revoke all on function public.of_list_sessions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.of_list_sessions(uuid, uuid) to service_role;
revoke all on function public.of_get_admin_for_password_change(uuid) from public, anon, authenticated;
grant execute on function public.of_get_admin_for_password_change(uuid) to service_role;
revoke all on function public.of_change_password(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.of_change_password(uuid, uuid, text, text, jsonb) to service_role;

insert into one_fetch.migration_history (version, checksum)
values (
  '202609040005',
  encode(extensions.digest(convert_to('one-fetch-supabase-canonical-control-v1', 'UTF8'), 'sha256'), 'hex')
);

commit;
