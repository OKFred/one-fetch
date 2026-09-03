begin;

create or replace function public.of_get_instance_state()
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
        'configRevision', config_revision,
        'configVersion', config_version,
        'updatedAt', updated_at
      )
      from instance_state
      where singleton
    ),
    '{"initialized":false}'::jsonb
  );
$$;

create or replace function public.of_bootstrap_admin(
  p_instance_id uuid,
  p_username text,
  p_password_hash text,
  p_config_version text,
  p_default_config jsonb,
  p_audit jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_admin_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('one-fetch-bootstrap'));

  insert into instance_state (
    singleton,
    instance_id,
    initialized,
    config_revision,
    config_version,
    active_config
  ) values (
    true,
    p_instance_id,
    false,
    0,
    p_config_version,
    p_default_config
  ) on conflict (singleton) do nothing;

  if (select initialized from instance_state where singleton for update) then
    raise exception using errcode = 'P0001', message = 'instance_already_initialized';
  end if;

  if nullif(btrim(p_username), '') is null or char_length(p_username) > 80 then
    raise exception using errcode = '22023', message = 'invalid_username';
  end if;

  insert into admins (username, password_hash)
  values (btrim(p_username), p_password_hash)
  returning id into v_admin_id;

  insert into config_revisions (
    revision,
    version,
    config,
    config_hash,
    changed_fields,
    changed_by
  ) values (
    0,
    p_config_version,
    p_default_config,
    encode(extensions.digest(convert_to(p_default_config::text, 'UTF8'), 'sha256'), 'hex'),
    array['bootstrap'],
    v_admin_id
  );

  update instance_state
  set initialized = true,
      updated_at = clock_timestamp()
  where singleton;

  perform append_audit(p_audit);
  return jsonb_build_object('adminId', v_admin_id, 'configVersion', p_config_version);
end;
$$;

create or replace function public.of_get_admin_for_login(p_username text)
returns jsonb
language sql
stable
security definer
set search_path = one_fetch, pg_temp
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'adminId', id,
        'passwordHash', password_hash,
        'failedLoginCount', failed_login_count,
        'lockedUntil', locked_until,
        'totpConfigured', totp_ciphertext is not null
      )
      from admins
      where username_normalized = lower(btrim(p_username))
    ),
    'null'::jsonb
  );
$$;

create or replace function public.of_record_login_failure(p_admin_id uuid, p_audit jsonb)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_count integer;
  v_locked_until timestamptz;
begin
  update admins
  set failed_login_count = failed_login_count + 1,
      locked_until = case
        when failed_login_count + 1 >= 5 then clock_timestamp() + interval '15 minutes'
        else locked_until
      end,
      updated_at = clock_timestamp()
  where id = p_admin_id
  returning failed_login_count, locked_until into v_count, v_locked_until;

  perform append_audit(p_audit);
  return jsonb_build_object('failedLoginCount', v_count, 'lockedUntil', v_locked_until);
end;
$$;

create or replace function public.of_issue_session(
  p_admin_id uuid,
  p_family_id uuid,
  p_access_hash text,
  p_refresh_hash text,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz,
  p_device_label text,
  p_client_fingerprint text,
  p_audit jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_session_id uuid;
begin
  update admins
  set failed_login_count = 0,
      locked_until = null,
      last_login_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = p_admin_id;

  insert into sessions (
    admin_id,
    family_id,
    access_token_hash,
    refresh_token_hash,
    access_expires_at,
    refresh_expires_at,
    device_label,
    client_fingerprint
  ) values (
    p_admin_id,
    p_family_id,
    p_access_hash,
    p_refresh_hash,
    p_access_expires_at,
    p_refresh_expires_at,
    nullif(left(p_device_label, 120), ''),
    nullif(left(p_client_fingerprint, 128), '')
  ) returning id into v_session_id;

  perform append_audit(p_audit);
  return jsonb_build_object('sessionId', v_session_id, 'familyId', p_family_id);
end;
$$;

create or replace function public.of_authenticate_access(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_result jsonb;
begin
  update sessions
  set last_seen_at = clock_timestamp()
  where access_token_hash = p_token_hash
    and revoked_at is null
    and access_expires_at > clock_timestamp()
  returning jsonb_build_object(
    'adminId', admin_id,
    'sessionId', id,
    'familyId', family_id,
    'accessExpiresAt', access_expires_at
  ) into v_result;
  return coalesce(v_result, 'null'::jsonb);
end;
$$;

create or replace function public.of_rotate_refresh(
  p_current_hash text,
  p_new_access_hash text,
  p_new_refresh_hash text,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz,
  p_audit_success jsonb,
  p_audit_reuse jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_session sessions%rowtype;
  v_reused_family uuid;
begin
  select * into v_session
  from sessions
  where refresh_token_hash = p_current_hash
  for update;

  if found and v_session.revoked_at is null and v_session.refresh_expires_at > clock_timestamp() then
    insert into refresh_token_history (token_hash, family_id, session_id, expires_at)
    values (v_session.refresh_token_hash, v_session.family_id, v_session.id, v_session.refresh_expires_at);

    update sessions
    set access_token_hash = p_new_access_hash,
        refresh_token_hash = p_new_refresh_hash,
        access_expires_at = p_access_expires_at,
        refresh_expires_at = p_refresh_expires_at,
        rotated_at = clock_timestamp(),
        last_seen_at = clock_timestamp()
    where id = v_session.id;

    perform append_audit(p_audit_success);
    return jsonb_build_object(
      'status', 'rotated',
      'adminId', v_session.admin_id,
      'sessionId', v_session.id,
      'familyId', v_session.family_id
    );
  end if;

  select family_id into v_reused_family
  from refresh_token_history
  where token_hash = p_current_hash and expires_at > clock_timestamp();

  if found then
    update sessions
    set revoked_at = coalesce(revoked_at, clock_timestamp()),
        revoke_reason = coalesce(revoke_reason, 'refresh_reuse')
    where family_id = v_reused_family;
    perform append_audit(p_audit_reuse);
    return jsonb_build_object('status', 'reuse', 'familyId', v_reused_family);
  end if;

  return jsonb_build_object('status', 'invalid');
end;
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
  set revoked_at = coalesce(revoked_at, clock_timestamp()),
      revoke_reason = coalesce(revoke_reason, left(p_reason, 120))
  where id = p_session_id and admin_id = p_admin_id;
  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    perform append_audit(p_audit);
  end if;
  return v_updated > 0;
end;
$$;

create or replace function public.of_create_execution_token(
  p_admin_id uuid,
  p_name text,
  p_token_hash text,
  p_scopes jsonb,
  p_quotas jsonb,
  p_expires_at timestamptz,
  p_audit jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_id uuid;
  v_created_at timestamptz;
begin
  insert into execution_tokens (name, token_hash, scopes, quotas, created_by, expires_at)
  values (btrim(p_name), p_token_hash, p_scopes, p_quotas, p_admin_id, p_expires_at)
  returning id, created_at into v_id, v_created_at;
  perform append_audit(p_audit);
  return jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 1,
    'id', v_id,
    'name', btrim(p_name),
    'scope', p_scopes,
    'quota', p_quotas,
    'createdAt', v_created_at,
    'expiresAt', p_expires_at
  ));
end;
$$;

create or replace function public.of_authenticate_execution(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_result jsonb;
begin
  update execution_tokens
  set last_used_at = clock_timestamp()
  where token_hash = p_token_hash
    and revoked_at is null
    and (expires_at is null or expires_at > clock_timestamp())
  returning jsonb_build_object(
    'tokenId', id,
    'name', name,
    'scopes', scopes,
    'quotas', quotas,
    'expiresAt', expires_at
  ) into v_result;
  return coalesce(v_result, 'null'::jsonb);
end;
$$;

create or replace function public.of_revoke_execution_token(
  p_admin_id uuid,
  p_token_id uuid,
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
  update execution_tokens
  set revoked_at = coalesce(revoked_at, clock_timestamp()),
      revoke_reason = coalesce(revoke_reason, left(p_reason, 120))
  where id = p_token_id;
  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    perform append_audit(p_audit);
  end if;
  return v_updated > 0;
end;
$$;

create or replace function public.of_list_execution_tokens(p_admin_id uuid)
returns setof jsonb
language sql
stable
security definer
set search_path = one_fetch, pg_temp
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 1,
    'id', id,
    'name', name,
    'scope', scopes,
    'quota', quotas,
    'createdAt', created_at,
    'expiresAt', expires_at,
    'revokedAt', revoked_at
  ))
  from execution_tokens
  order by created_at desc;
$$;
revoke all on function public.of_get_instance_state() from public, anon, authenticated;
grant execute on function public.of_get_instance_state() to service_role;
revoke all on function public.of_bootstrap_admin(uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.of_bootstrap_admin(uuid, text, text, text, jsonb, jsonb) to service_role;
revoke all on function public.of_get_admin_for_login(text) from public, anon, authenticated;
grant execute on function public.of_get_admin_for_login(text) to service_role;
revoke all on function public.of_record_login_failure(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.of_record_login_failure(uuid, jsonb) to service_role;
revoke all on function public.of_issue_session(uuid, uuid, text, text, timestamptz, timestamptz, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.of_issue_session(uuid, uuid, text, text, timestamptz, timestamptz, text, text, jsonb) to service_role;
revoke all on function public.of_authenticate_access(text) from public, anon, authenticated;
grant execute on function public.of_authenticate_access(text) to service_role;
revoke all on function public.of_rotate_refresh(text, text, text, timestamptz, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.of_rotate_refresh(text, text, text, timestamptz, timestamptz, jsonb, jsonb) to service_role;
revoke all on function public.of_revoke_session(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.of_revoke_session(uuid, uuid, text, jsonb) to service_role;
revoke all on function public.of_create_execution_token(uuid, text, text, jsonb, jsonb, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.of_create_execution_token(uuid, text, text, jsonb, jsonb, timestamptz, jsonb) to service_role;
revoke all on function public.of_authenticate_execution(text) from public, anon, authenticated;
grant execute on function public.of_authenticate_execution(text) to service_role;
revoke all on function public.of_revoke_execution_token(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.of_revoke_execution_token(uuid, uuid, text, jsonb) to service_role;
revoke all on function public.of_list_execution_tokens(uuid) from public, anon, authenticated;
grant execute on function public.of_list_execution_tokens(uuid) to service_role;

insert into one_fetch.migration_history (version, checksum)
values (
  '202609040002',
  encode(extensions.digest(convert_to('one-fetch-supabase-auth-v1', 'UTF8'), 'sha256'), 'hex')
);

commit;
