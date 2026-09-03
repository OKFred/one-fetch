begin;

create table one_fetch.login_throttles (
  kind text not null check (kind in (
    'login-source', 'login-username', 'bootstrap-source', 'refresh-source'
  )),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null default clock_timestamp(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  blocked_until timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (kind, key_hash)
);

create index login_throttles_updated_idx
  on one_fetch.login_throttles (updated_at);

create or replace function one_fetch.bump_login_throttle(
  p_kind text,
  p_key_hash text,
  p_limit integer
)
returns text
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_row login_throttles%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_kind not in (
       'login-source', 'login-username', 'bootstrap-source', 'refresh-source'
     )
     or p_key_hash !~ '^[0-9a-f]{64}$'
     or p_limit < 1 then
    raise exception using errcode = '22023', message = 'invalid login throttle input';
  end if;

  insert into login_throttles (kind, key_hash)
  values (p_kind, p_key_hash)
  on conflict do nothing;

  select * into v_row
  from login_throttles
  where kind = p_kind and key_hash = p_key_hash
  for update;

  if v_row.blocked_until is not null and v_row.blocked_until > v_now then
    return 'already-blocked';
  end if;

  if v_row.window_started_at <= v_now - interval '5 minutes' then
    update login_throttles
    set window_started_at = v_now,
        attempt_count = 1,
        blocked_until = null,
        updated_at = v_now
    where kind = p_kind and key_hash = p_key_hash;
    return 'allowed';
  end if;

  if v_row.attempt_count + 1 > p_limit then
    update login_throttles
    set attempt_count = attempt_count + 1,
        blocked_until = v_now + interval '15 minutes',
        updated_at = v_now
    where kind = p_kind and key_hash = p_key_hash;
    return 'newly-blocked';
  end if;

  update login_throttles
  set attempt_count = attempt_count + 1,
      blocked_until = null,
      updated_at = v_now
  where kind = p_kind and key_hash = p_key_hash;
  return 'allowed';
end;
$$;

create or replace function public.of_begin_auth_source_attempt(
  p_kind text,
  p_source_hash text,
  p_limit integer,
  p_denied_audit jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_state text;
begin
  delete from login_throttles
  where updated_at < clock_timestamp() - interval '1 day'
    and (blocked_until is null or blocked_until <= clock_timestamp());

  v_state := bump_login_throttle(p_kind, p_source_hash, p_limit);
  if v_state = 'newly-blocked' then
    perform append_audit(p_denied_audit);
  end if;
  return jsonb_build_object('allowed', v_state = 'allowed');
end;
$$;

create or replace function public.of_begin_login_attempt(
  p_username_hash text,
  p_source_hash text,
  p_denied_audit jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_state text;
begin
  delete from login_throttles
  where updated_at < clock_timestamp() - interval '1 day'
    and (blocked_until is null or blocked_until <= clock_timestamp());

  v_state := bump_login_throttle('login-source', p_source_hash, 30);
  if v_state = 'allowed' then
    v_state := bump_login_throttle('login-username', p_username_hash, 10);
  end if;
  if v_state = 'newly-blocked' then
    perform append_audit(p_denied_audit);
  end if;
  return jsonb_build_object('allowed', v_state = 'allowed');
end;
$$;

create or replace function public.of_bootstrap_admin_session(
  p_instance_id uuid,
  p_admin_id uuid,
  p_session_id uuid,
  p_username text,
  p_password_hash text,
  p_config_version text,
  p_default_config jsonb,
  p_family_id uuid,
  p_access_hash text,
  p_refresh_hash text,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz,
  p_device_label text,
  p_client_fingerprint text,
  p_audit_bootstrap jsonb,
  p_audit_session jsonb,
  p_audit_already_initialized jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('one-fetch-bootstrap'));
  insert into instance_state (
    singleton, instance_id, initialized, config_revision,
    config_version, active_config
  ) values (
    true, p_instance_id, false, 0, p_config_version, p_default_config
  ) on conflict (singleton) do nothing;

  if exists (
    select 1 from instance_state
    where singleton and instance_id <> p_instance_id
  ) then
    perform append_audit(p_audit_already_initialized);
    return jsonb_build_object('status', 'already_initialized');
  end if;

  if (select initialized from instance_state where singleton for update) then
    perform append_audit(p_audit_already_initialized);
    return jsonb_build_object('status', 'already_initialized');
  end if;
  if nullif(btrim(p_username), '') is null or char_length(p_username) > 80 then
    raise exception using errcode = '22023', message = 'invalid_username';
  end if;

  insert into admins (id, username, password_hash)
  values (p_admin_id, btrim(p_username), p_password_hash);
  insert into config_revisions (
    revision, version, config, config_hash, changed_fields, changed_by
  ) values (
    0, p_config_version, p_default_config,
    encode(extensions.digest(convert_to(p_default_config::text, 'UTF8'), 'sha256'), 'hex'),
    array['bootstrap'], p_admin_id
  );
  update instance_state
  set initialized = true, updated_at = clock_timestamp()
  where singleton;
  insert into sessions (
    id, admin_id, family_id, access_token_hash, refresh_token_hash,
    access_expires_at, refresh_expires_at, device_label, client_fingerprint
  ) values (
    p_session_id, p_admin_id, p_family_id, p_access_hash, p_refresh_hash,
    p_access_expires_at, p_refresh_expires_at,
    nullif(left(p_device_label, 120), ''),
    nullif(left(p_client_fingerprint, 128), '')
  );
  perform append_audit(p_audit_bootstrap);
  perform append_audit(p_audit_session);
  return jsonb_build_object('status', 'created', 'sessionId', p_session_id);
end;
$$;

create or replace function public.of_issue_session_guarded(
  p_admin_id uuid,
  p_expected_password_hash text,
  p_expected_totp_configured boolean,
  p_family_id uuid,
  p_access_hash text,
  p_refresh_hash text,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz,
  p_device_label text,
  p_client_fingerprint text,
  p_username_hash text,
  p_source_hash text,
  p_audit jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_admin admins%rowtype;
  v_session_id uuid;
begin
  select * into v_admin from admins where id = p_admin_id for update;
  if not found
     or v_admin.password_hash <> p_expected_password_hash
     or (v_admin.locked_until is not null and v_admin.locked_until > clock_timestamp())
     or (v_admin.totp_ciphertext is not null) <> p_expected_totp_configured then
    return 'null'::jsonb;
  end if;
  update admins
  set failed_login_count = 0, locked_until = null,
      last_login_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_admin_id;
  insert into sessions (
    admin_id, family_id, access_token_hash, refresh_token_hash,
    access_expires_at, refresh_expires_at, device_label, client_fingerprint
  ) values (
    p_admin_id, p_family_id, p_access_hash, p_refresh_hash,
    p_access_expires_at, p_refresh_expires_at,
    nullif(left(p_device_label, 120), ''),
    nullif(left(p_client_fingerprint, 128), '')
  ) returning id into v_session_id;
  delete from login_throttles
  where (kind = 'login-username' and key_hash = p_username_hash)
     or (kind = 'login-source' and key_hash = p_source_hash);
  perform append_audit(p_audit);
  return jsonb_build_object('sessionId', v_session_id, 'familyId', p_family_id);
end;
$$;

create or replace function public.of_rotate_refresh_audited(
  p_current_hash text,
  p_new_access_hash text,
  p_new_refresh_hash text,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz,
  p_audit_success jsonb,
  p_audit_reuse jsonb,
  p_audit_invalid jsonb
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
  select * into v_session from sessions
  where refresh_token_hash = p_current_hash for update;
  if found and v_session.revoked_at is null
     and v_session.refresh_expires_at > clock_timestamp() then
    insert into refresh_token_history (token_hash, family_id, session_id, expires_at)
    values (v_session.refresh_token_hash, v_session.family_id, v_session.id, v_session.refresh_expires_at);
    update sessions
    set access_token_hash = p_new_access_hash,
        refresh_token_hash = p_new_refresh_hash,
        access_expires_at = p_access_expires_at,
        refresh_expires_at = p_refresh_expires_at,
        rotated_at = clock_timestamp(), last_seen_at = clock_timestamp()
    where id = v_session.id;
    perform append_audit(p_audit_success);
    return jsonb_build_object(
      'status', 'rotated', 'adminId', v_session.admin_id,
      'sessionId', v_session.id, 'familyId', v_session.family_id
    );
  end if;
  select family_id into v_reused_family from refresh_token_history
  where token_hash = p_current_hash and expires_at > clock_timestamp();
  if found then
    update sessions
    set revoked_at = coalesce(revoked_at, clock_timestamp()),
        revoke_reason = coalesce(revoke_reason, 'refresh_reuse')
    where family_id = v_reused_family;
    perform append_audit(p_audit_reuse);
    return jsonb_build_object('status', 'reuse', 'familyId', v_reused_family);
  end if;
  perform append_audit(p_audit_invalid);
  return jsonb_build_object('status', 'invalid');
end;
$$;

create or replace function public.of_mark_audit_degraded(p_audit jsonb)
returns boolean
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_updated integer;
begin
  update instance_state
  set audit_degraded = true, updated_at = clock_timestamp()
  where singleton and not audit_degraded;
  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    perform append_audit(p_audit);
  end if;
  return v_updated > 0;
end;
$$;

create or replace function public.of_set_audit_degraded()
returns boolean
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_updated integer;
begin
  update instance_state
  set audit_degraded = true, updated_at = clock_timestamp()
  where singleton and not audit_degraded;
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

create or replace function public.of_get_control_runtime_state()
returns jsonb
language sql
stable
security definer
set search_path = one_fetch, pg_temp
as $$
  select coalesce((
    select jsonb_build_object(
      'instanceId', instance_id,
      'initialized', initialized,
      'auditDegraded', audit_degraded
    ) from instance_state where singleton
  ), jsonb_build_object(
    'initialized', false,
    'auditDegraded', false
  )) || jsonb_build_object(
    'migrations', coalesce((
      select jsonb_agg(
        jsonb_build_object('version', version, 'checksum', checksum)
        order by version
      ) from migration_history
    ), '[]'::jsonb)
  );
$$;

revoke all on table one_fetch.login_throttles from public, anon, authenticated;
revoke all on function one_fetch.bump_login_throttle(text, text, integer) from public, anon, authenticated;
revoke all on function public.of_begin_auth_source_attempt(text, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.of_begin_auth_source_attempt(text, text, integer, jsonb) to service_role;
revoke all on function public.of_begin_login_attempt(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.of_begin_login_attempt(text, text, jsonb) to service_role;
revoke all on function public.of_bootstrap_admin_session(
  uuid, uuid, uuid, text, text, text, jsonb, uuid, text, text,
  timestamptz, timestamptz, text, text, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.of_bootstrap_admin_session(
  uuid, uuid, uuid, text, text, text, jsonb, uuid, text, text,
  timestamptz, timestamptz, text, text, jsonb, jsonb, jsonb
) to service_role;
revoke all on function public.of_issue_session_guarded(
  uuid, text, boolean, uuid, text, text, timestamptz, timestamptz,
  text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.of_issue_session_guarded(
  uuid, text, boolean, uuid, text, text, timestamptz, timestamptz,
  text, text, text, text, jsonb
) to service_role;
revoke all on function public.of_rotate_refresh_audited(
  text, text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.of_rotate_refresh_audited(
  text, text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb
) to service_role;
revoke all on function public.of_mark_audit_degraded(jsonb) from public, anon, authenticated;
grant execute on function public.of_mark_audit_degraded(jsonb) to service_role;
revoke all on function public.of_set_audit_degraded() from public, anon, authenticated;
grant execute on function public.of_set_audit_degraded() to service_role;
revoke all on function public.of_get_control_runtime_state() from public, anon, authenticated;
grant execute on function public.of_get_control_runtime_state() to service_role;

insert into one_fetch.migration_history (version, checksum)
values (
  '202609040008',
  encode(extensions.digest(
    convert_to('one-fetch-supabase-control-hardening-v1', 'UTF8'),
    'sha256'
  ), 'hex')
);

commit;
