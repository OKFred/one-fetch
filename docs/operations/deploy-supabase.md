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
  --expected-current-build <deployed-build-or-none>
```

PowerShell uses `scripts/deploy.ps1` with `-ProjectRef`, `-EnvFile`, and
`-ExpectedCurrentBuild`. Use `none` only when neither Function exists. The command
runs all local checks, embeds the exact commit build ID into both bundles,
records bundle digests, strictly inventories the exact project and current
pair/build, runs `db push --dry-run --skip-vault`, and records a non-secret backup
summary. Every remote command carries the project ref; no linked-project state is
written.

`--apply`/`-Apply` is deliberately fail-closed in 0.1 Preview. It writes a blocked
plan under `artifacts/supabase-deployments/` (or the explicit state path), then
exits before any database, Secret, or Function mutation. Do not bypass this gate
with manual commands. Safe apply requires all of the following first:

- a remote deployment lease with transactional compare-and-swap, expiry and
  deployment audit events;
- an immutable backup ID bound to this project plus recorded restore-test
  evidence;
- a resumable plan that binds the exact commit and both bundle hashes;
- final strict Function inventory and Control/Gateway runtime identity checks.

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

No hosted mutation is performed by the Preview planner. When apply is later
enabled, recovery must prefer an audited roll-forward from the exact plan. If
that is unsafe, restore the attested pre-deploy backup into a separate project,
verify it, then switch configuration; never apply reverse SQL to the active
store.
