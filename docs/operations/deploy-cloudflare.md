# Cloudflare deployment runbook

## Topology

Deploy two Workers: Control owns D1, authentication/quota Durable Objects, audit,
and reports; Gateway reaches Control through a Service Binding. Use separate
hostnames. Production compatibility date is pinned in Wrangler configuration
and changes only through a tested pull request.

Persistent Workers observability is disabled by repository configuration, but
operators must still review account-level logs, Logpush, security analytics, and
retention. Cloudflare can observe the outer Gateway path/query and can mutate
headers.

## Safe sequence

1. Run the Cloudflare tests, generated type check, startup check, and both
   Wrangler dry-runs locally/CI.
2. Select the exact account and unique Preview names. Never infer an account
   when more than one is available.
3. Create a dedicated D1 database and record its ID in a deployment-specific
   Wrangler configuration that is not committed.
4. Apply the checked-in forward migrations to that database.
5. Generate and set independent `BOOTSTRAP_SECRET`, `INSTANCE_PEPPER`,
   `ENCRYPTION_KEY`, and `AUDIT_SIGNING_KEY` secrets without printing them.
6. Deploy Control first, including Auth/Quota Durable Object migrations.
7. Bind Gateway to that exact Control Worker and deploy Gateway with no custom
   production route.
8. Validate on `workers.dev` or a non-production Preview hostname.
9. Only after acceptance, bind the separately approved Control/Gateway custom
   hostnames or traffic routes.

The committed configs are review inputs. The repository deployment tool creates
deployment-specific private configs and an exact resource journal under the
ignored `.tools/cloudflare/<deployment-id>/` directory. CI has no Cloudflare API
token and never creates resources.

## Deployment tool

Use Wrangler 4.128.0 through the root command. Deployment IDs are lowercase,
3–40 characters, and become the exact names `<id>-control`, `<id>-gateway`, and
`<id>-db`. Start with the read-only plan:

```sh
pnpm deploy:cloudflare plan --deployment-id one-fetch-preview-a1 \
  --build-id 0.1.0+COMMIT --expected-build none
```

For a first install, create a mode-0600 JSON file containing exactly
`BOOTSTRAP_SECRET`, `INSTANCE_PEPPER`, `ENCRYPTION_KEY`, and
`AUDIT_SIGNING_KEY`. Every value must have at least 32 characters. Pass the path;
never put a secret value in an argument:

```sh
pnpm deploy:cloudflare:secrets -- --output /restricted/cloudflare-secrets.json
```

The generator refuses to overwrite a file and does not print secret values.
Pass the resulting path to deployment; delete it after the secrets have been
set and retain the instance recovery material through the operator's secret
manager when the deployment is not temporary.

```sh
pnpm deploy:cloudflare apply --deployment-id one-fetch-preview-a1 \
  --build-id 0.1.0+COMMIT --expected-build none \
  --secrets-file /restricted/cloudflare-secrets.json
```

Bootstrap the administrator separately, put the resulting admin access token in
a restricted file, and verify. Add `--resume` only after acceptance succeeds:

```sh
pnpm deploy:cloudflare verify --deployment-id one-fetch-preview-a1 \
  --expected-build 0.1.0+COMMIT --resume \
  --admin-token-file /restricted/admin-token
```

Access tokens expire after 15 minutes. For a long update or acceptance run,
refresh the restricted token file from the separately protected administrator
credential file without printing either secret:

```sh
pnpm acceptance:refresh-admin -- \
  --control-url https://CONTROL.example \
  --administrator-file /restricted/administrator.json \
  --token-file /restricted/admin-token
```

An update changes `--expected-build` to the currently deployed build and requires
`--admin-token-file`. The tool pauses Gateway, captures the current Worker version
IDs, D1 Time Travel bookmark, a SQL export, and its SHA-256 before migrations or
deployment. Verification leaves Gateway paused unless `--resume` is explicit.

Rollback points come from `wrangler deployments status`, not the latest uploaded
version. Exactly one version must carry 100% traffic; split deployments and
out-of-band changes to the recorded Worker versions require operator review.
An update requires a verified or explicitly rolled-back starting state.

The helper flushes a local checkpoint before pause, migrations and each Worker
deployment. It records the backup path, SHA-256, Time Travel bookmark and old
active versions before changing schema or code. `gatewayPaused: null` means a
pause was requested but its outcome is unknown, not that traffic is stopped.
After an interrupted update, `buildId` stays at the old build until both Worker
deployments finish; `update.targetBuildId` and `update.phase` identify the attempt.
Do not use `verify --resume` to bypass an incomplete/failed lifecycle. Inspect the
remote state and use explicit code rollback when a backup point is recorded.

The current helper also uses a shared D1 compare-and-swap lock across install,
update, verify/resume, rollback and cleanup. Account, D1 UUID, deployment names
and expected build are pinned. An update must use a distinct build ID. There is
no expiry or automatic stale-process takeover: errors, lost acknowledgements
and process death retain the lock. Local operation journals record its owner
and revision, not credentials.

This is cooperative coordination, not a platform fencing guarantee or an OS
power-loss guarantee. Cloudflare deployment APIs cannot check our D1 revision;
dashboard changes, older helpers and privileged SQL can bypass it. Do not run
those concurrently. D1 exports remain sensitive and need restricted access.

### Adopting an older deployment

Older deployment records have no pinned account or coordination table. Normal
mutations refuse them. Stop **all** deployment helpers first, verify the account
and recorded active versions, then explicitly adopt:

```sh
pnpm deploy:cloudflare adopt --deployment-id one-fetch-preview-a1 \
  --account-id ACCOUNT_ID --expected-build 0.1.0+COMMIT \
  --confirm-stopped one-fetch-preview-a1 \
  --admin-token-file /restricted/admin-token
```

Adoption requires a verified/rolled-back starting state, pauses Gateway, exports
and hashes D1 before creating the coordination table, and leaves traffic paused.
Existing tables are never overwritten, including empty or malformed ones.
Adoption itself requires operator-enforced quiescence because the shared lock
does not yet exist. Incomplete legacy installations require manual review.

### Recovering a retained lock

Inspect without mutation:

```sh
pnpm deploy:cloudflare coordination --deployment-id one-fetch-preview-a1
```

After confirming every old helper has stopped, append all three options to
`rollback`, `cleanup`, or an otherwise valid `verify`:
`--recover-owner OWNER_UUID --recover-revision REVISION --confirm-stopped ID`.
Recovery performs a CAS on that exact owner/revision; ordinary `apply` cannot
take over. A very old timestamp is not permission to recover. If verification
is ineligible because the lifecycle is incomplete, use rollback or cleanup.
Missing/malformed rows or an unacknowledged table initialization require manual
inspection, not dropping/recreating the table or rerunning an install.

A SQL backup includes the coordination row as it existed while the operation
held its lock. An isolated restore therefore retains the old database identity
and owner; do not treat that copy as an unlocked deployment. Review/rebind a
replacement identity explicitly, with all helpers stopped, before any cutover.

Rollback restores the recorded Control and Gateway Worker versions only. It
keeps Gateway paused and reports `databaseRestored: false`; D1 restoration is a
separate reviewed procedure into an isolated database.

Temporary deployments are deleted only when the confirmation exactly matches the
deployment ID:

```sh
pnpm deploy:cloudflare cleanup --deployment-id one-fetch-preview-a1 \
  --confirm-id one-fetch-preview-a1
```

The command deletes only the journaled Workers and D1 UUID, then re-lists the
account and fails unless all three are absent. Worker deletion must be confirmed
before D1 is deleted, preserving the lock on a partial Worker failure. If the
database deletion acknowledgement or final local write is lost, inspect the
exact account inventory manually; an absent D1 cannot provide another lock and
the helper will not infer permission to delete a same-name replacement.

## Acceptance and cleanup

Run shared conformance with synthetic data plus bootstrap/login, policy, quota,
audit, report expiry, cancellation, large streaming body, redirect, WebSocket
(only if advertised), version mismatch, and backup/restore exercises. Confirm
DNS/TCP/TLS phases are unavailable rather than zero and inspect advertised
header mutations.

When the synthetic target is itself a Cloudflare Worker, pass `--target-profile
cloudflare-worker` to the conformance runner. Workers normalize a deliberately
errored response stream before another Worker receives it, so that single
failure-injection case is recorded as an explicit platform skip. Unknown-length
response overflow is still required to produce a signed `partial` execution
report even when the outer client receives a cleanly ended stream.

Temporary fixture Workers use random names. After testing, delete exactly those
fixtures and verify routes, service bindings, secrets, D1 databases, and Durable
Object namespaces that were created for the fixture. Never delete by prefix or
from an unresolved variable.

Rollback traffic to the last known-good immutable Worker versions. Database
rollback uses a restored replacement D1 database; do not reverse migrations in
place. Rebind only after integrity and conformance checks succeed.
