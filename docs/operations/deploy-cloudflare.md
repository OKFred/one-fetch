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

The committed configs are review inputs, not an unattended deploy button. CI has
no Cloudflare API token and never creates resources.

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
