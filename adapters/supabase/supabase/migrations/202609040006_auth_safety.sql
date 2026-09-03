begin;

create or replace function public.of_record_login_failure(
  p_admin_id uuid,
  p_audit jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = one_fetch, pg_temp
as $$
declare
  v_count integer;
  v_locked_until timestamptz;
begin
  select failed_login_count, locked_until
  into v_count, v_locked_until
  from admins
  where id = p_admin_id
  for update;

  if not found then
    return 'null'::jsonb;
  end if;

  if v_locked_until is null or v_locked_until <= clock_timestamp() then
    v_count := v_count + 1;
    v_locked_until := case
      when v_count >= 5 then clock_timestamp() + interval '15 minutes'
      else null
    end;
    update admins
    set failed_login_count = v_count,
        locked_until = v_locked_until,
        updated_at = clock_timestamp()
    where id = p_admin_id;
  end if;

  perform append_audit(p_audit);
  return jsonb_build_object(
    'failedLoginCount', v_count,
    'lockedUntil', v_locked_until
  );
end;
$$;

drop function public.of_issue_session(
  uuid, uuid, text, text, timestamptz, timestamptz, text, text, jsonb
);

create function public.of_issue_session(
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
  select * into v_admin
  from admins
  where id = p_admin_id
  for update;

  if not found
     or v_admin.password_hash <> p_expected_password_hash
     or (v_admin.locked_until is not null
         and v_admin.locked_until > clock_timestamp())
     or (v_admin.totp_ciphertext is not null) <> p_expected_totp_configured then
    return 'null'::jsonb;
  end if;

  update admins
  set failed_login_count = 0,
      locked_until = null,
      last_login_at = clock_timestamp(),
      updated_at = clock_timestamp()
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

  perform append_audit(p_audit);
  return jsonb_build_object('sessionId', v_session_id, 'familyId', p_family_id);
end;
$$;

revoke all on function public.of_issue_session(
  uuid, text, boolean, uuid, text, text, timestamptz, timestamptz,
  text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.of_issue_session(
  uuid, text, boolean, uuid, text, text, timestamptz, timestamptz,
  text, text, jsonb
) to service_role;

insert into one_fetch.migration_history (version, checksum)
values (
  '202609040006',
  encode(extensions.digest(
    convert_to('one-fetch-supabase-auth-safety-v1', 'UTF8'),
    'sha256'
  ), 'hex')
);

commit;
