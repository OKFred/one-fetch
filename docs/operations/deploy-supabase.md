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

## Hosted Preview

Generate the environment file outside the repository with the adapter helper.
It refuses overwrite and does not print secrets. Inspect the generated public
URLs and explicit project ref before applying.

```bash
cd adapters/supabase
./scripts/deploy.sh --project-ref <exact-ref> --env-file <secure-path>
./scripts/deploy.sh --project-ref <exact-ref> --env-file <secure-path> --apply
```

PowerShell uses `scripts/deploy.ps1` with `-ProjectRef`, `-EnvFile`, and
`-Apply`. The first command is a dry-run; review it before the second. The apply
path links the explicit project, applies migrations, sets secrets, then deploys
Control before Gateway. It does not create a project or modify xPanel.

## Acceptance

Run shared conformance plus database privilege checks, transaction/audit
coupling, quota races, report expiry, provider path logging, redirect policy,
body limits, cancellation, and version mismatch. WebSocket/TCP/TLS must remain
disabled unless capabilities and a real runtime probe prove them.

Review Edge Function logs and project retention: the provider may log the outer
Gateway path/query. A successful function deploy is not acceptance. Record the
function deployment IDs, migration checksums, capabilities/config timestamp,
synthetic evidence, and backup restore evidence.

Rollback functions to prior immutable bundles. Restore data into a separate
project/database, verify it, then switch configuration; do not apply reverse SQL
to the active store.
