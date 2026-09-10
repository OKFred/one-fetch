# Supabase deployment runbook

## Topology and boundary

Deploy `one-fetch-control` and `one-fetch-gateway` as independent Edge Functions
backed by one dedicated PostgreSQL project. Supabase reserves
`/functions/v1/<function-name>`; configure that complete prefix as the service
base. one-fetch reserves no path after the Gateway function prefix.

Both functions use `verify_jwt=false` because one-fetch owns opaque tokens. SQL
migrations keep tables in `one_fetch`, revoke `public`, `anon`, and
`authenticated`, and expose only narrowly scoped service-role RPCs.

## Local gate

Docker, Deno 2.9.6, and Supabase CLI 2.116.0 are required.

```bash
corepack pnpm --filter @one-fetch/adapter-supabase start
corepack pnpm --filter @one-fetch/adapter-supabase typecheck
corepack pnpm --filter @one-fetch/adapter-supabase test:integration
corepack pnpm --filter @one-fetch/adapter-supabase stop
```

Always use these pnpm wrappers. They create ignored, self-contained Function
entrypoints before the Supabase CLI runs; `config.toml` deliberately points at
those staged files. A bare `supabase start` from a fresh checkout has no runtime
entrypoint and is not a supported workflow. The same staging command runs in
the hosted deployment preflight so local and hosted execution cannot select
different source graphs.

Use only synthetic data. Confirm the local stack is stopped even after a failed
test.

## Hosted Preview preflight

Generate the environment file outside the repository with the adapter helper.
It refuses overwrite and does not print secrets. Inspect the generated public
URLs and explicit project ref before planning.

```bash
cd adapters/supabase
./scripts/deploy.sh --project-ref <exact-ref> --env-file <secure-path> \
  --expected-current-build <deployed-build-or-none> \
  --db-password-file <secure-database-password>
```

PowerShell uses `scripts/deploy.ps1` with `-ProjectRef`, `-EnvFile`, and
`-ExpectedCurrentBuild`. Use `none` only when neither Function exists. The command
runs all local checks, embeds the exact commit build ID into both bundles,
records bundle digests, strictly inventories the exact project and current
pair/build, creates an isolated CLI workdir, verifies that its IPv4 pooler link
belongs to the exact project, runs `db push --linked --dry-run --skip-vault`, and
records a non-secret backup summary. The isolated link state is removed when the
command completes or fails; it never modifies repository-local Supabase state.
Function inventory, deployment, secrets, backup inventory, and partial cleanup
also use the same isolated workdir.

Set a project-scoped Supabase access token in the CLI environment or native
credential store. The minimum hosted deployment capabilities are Project
Settings Read, Backups Read, Connection Pooling Read, API Keys Read, Edge
Functions Read-Write, and Edge Function Secrets Read-Write. Database preflight
also requires the password through `--db-password-file` or an explicitly scoped
`SUPABASE_DB_PASSWORD` environment variable; apply requires the restricted file.
Passwords and tokens never appear in CLI arguments, state files, reports, or
logs.

The read-only command writes a ready plan under
`artifacts/supabase-deployments/` (or the explicit state path). Inspect its exact
project, desired/current builds, Function inventory, bundle hashes and backup
summary before adding `--apply`/`-Apply`.

Hosted apply accepts secrets only by restricted file path. It requires the
project service-role key and database password; an update also requires a current
one-fetch admin access token so Gateway can be paused. On Bash:

```bash
./scripts/deploy.sh --project-ref <exact-ref> --env-file <secure-env> \
  --expected-current-build <deployed-build-or-none> --apply \
  --service-role-key-file <secure-service-role-key> \
  --db-password-file <secure-database-password> \
  [--admin-token-file <secure-admin-token>] [--resume]
```

PowerShell exposes the matching `-ServiceRoleKeyFile`,
`-DatabasePasswordFile`, `-AdminTokenFile`, `-Apply`, and `-Resume` parameters.
No secret value is placed in a command argument, state record, report, or log.

The apply sequence is fail-closed:

1. pause Gateway for an update and download the two currently deployed Function
   sources as exact recovery inputs;
2. create a logical database dump, require it to be non-empty, and record SHA-256;
3. for updates, acquire the database CAS lease before migration; for a first
   install, require the dump to contain no `one_fetch` schema, apply the initial
   migration, then acquire the `expectedBuild=none` lease;
4. apply only forward migrations, set secrets from the supplied env file, and
   deploy Control then Gateway, verifying each Function version transition;
5. renew the lease around remote steps, verify the running pair/build, complete
   the lease transaction, and resume only when `--resume` is explicit.

The lease and its lifecycle events live in PostgreSQL, so two deployment clients
cannot interleave based on local state alone. A stale expected build or active
lease is rejected transactionally. A failed update redeploys the captured prior
Function sources and remains paused. A failed first install deletes only the
Functions created by that run. Forward SQL is never reversed automatically.

Supabase deploys Control and Gateway independently; a local state file cannot
prevent two machines from interleaving those operations. Build identity is
embedded in each Function bundle rather than assigned later through a mutable
project Secret. Preserve the original pepper and audit-key material in protected
disaster-recovery storage; rotating it as part of an ordinary code deployment is
not supported.

## Acceptance

Run shared conformance plus database privilege checks, transaction/audit
coupling, quota races, report expiry, provider path logging, redirect policy,
body limits, cancellation, and version mismatch. WebSocket/TCP/TLS must remain
disabled unless capabilities and a real runtime probe prove them.

Review Edge Function logs and project retention: the provider may log the outer
Gateway path/query. A successful function deploy is not acceptance. Record the
function deployment IDs, migration checksums, capabilities/config timestamp,
synthetic evidence, and backup restore evidence.

Recovery should prefer an audited roll-forward from the exact state record. If
that is unsafe, restore the hashed pre-deploy dump into a separate project,
verify it, then switch configuration; never apply reverse SQL to the active
store. A created checksum proves backup integrity, not restore viability: the
release acceptance report must separately record an isolated restore test.
