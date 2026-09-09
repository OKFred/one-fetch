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

An update changes `--expected-build` to the currently deployed build and requires
`--admin-token-file`. The tool pauses Gateway, captures the current Worker version
IDs, D1 Time Travel bookmark, a SQL export, and its SHA-256 before migrations or
deployment. Verification leaves Gateway paused unless `--resume` is explicit.

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
account and fails unless all three are absent. A partial failure remains recorded
as `cleanup-failed` for manual recovery.

## Acceptance and cleanup

Run shared conformance with synthetic data plus bootstrap/login, policy, quota,
audit, report expiry, cancellation, large streaming body, redirect, WebSocket
(only if advertised), version mismatch, and backup/restore exercises. Confirm
DNS/TCP/TLS phases are unavailable rather than zero and inspect advertised
header mutations.

Temporary fixture Workers use random names. After testing, delete exactly those
fixtures and verify routes, service bindings, secrets, D1 databases, and Durable
Object namespaces that were created for the fixture. Never delete by prefix or
from an unresolved variable.

Rollback traffic to the last known-good immutable Worker versions. Database
rollback uses a restored replacement D1 database; do not reverse migrations in
place. Rebind only after integrity and conformance checks succeed.
