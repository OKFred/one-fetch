# one-fetch Supabase adapter

This adapter runs one-fetch as two independently deployed Supabase Edge Functions backed by Postgres:

- `one-fetch-control` exposes canonical `/api/v1/*` routes for bootstrap, authentication, capabilities, configuration, execution tokens, audit queries, and short-lived reports.
- `one-fetch-gateway` treats every path after the function base URL as the target path. It does not reserve `/v1`, `/api`, or another target path.

Supabase itself necessarily reserves `/functions/v1/one-fetch-gateway` to select the Edge Function. Configure that complete URL as the Gateway base; everything appended by xPanel is preserved as the target path/query.

## Preview capabilities

HTTP uses native Fetch and Web Streams. It validates the shared one-fetch protocol, preserves the target status/body, carries repeated `Set-Cookie` values in signed metadata, applies system and user policy rules, enforces per-token fixed-minute/concurrency/daily-byte quotas, supports cancellation and 60-second default timeouts, and writes redacted signed audit records. Responses stream; Preview request bodies are buffered up to the 20 MiB protocol limit so their declared size/hash and body policy can be verified before forwarding. Target `Set-Cookie` is never emitted against the Supabase hostname.

Supabase can add or rewrite transport headers, merge ordinary duplicate headers, decode content encoding, and add response headers. The adapter may also merge ordinary duplicate request fields while materializing native `Headers`; explicit Cookie fields are joined deliberately. Capabilities and xPanel must present those mutations. The runtime does not expose separate DNS, TCP, or TLS timings; they are reported as unavailable rather than zero. Target `Server-Timing` is retained separately.

WebSocket and outbound TCP/TLS are reported as `unsupported` in the Preview adapter. They must not be advertised as enabled until their shared tunnel protocol and a deployment runtime probe pass. Edge Function wall-clock/runtime limits still apply to WebSocket sessions even after a future capability is enabled.

Canonical Control paths include `GET|POST /api/v1/bootstrap`, `/api/v1/auth/*`, `/api/v1/config/*`, `/api/v1/tokens/execution`, `/api/v1/audit`, `/api/v1/features`, `/api/v1/alerts`, `/api/v1/backups`, and `/api/v1/reports/:reportId`. Session listing/revocation, logout, password changes, policy updates, and Gateway pause are implemented; password changes revoke every other session in the same audited database transaction. TOTP, alerts, backups, audit export, and Webhooks remain explicitly `unsupported`. Their feature-state records are available from `/api/v1/features`; invoking an unsupported operation returns the canonical HTTP 501 `feature_unsupported` error instead of a synthetic success. Capabilities, health, feature status, and report lookup permit configured client origins; all other Control routes permit only configured admin origins. Report lookup uses `Authorization: Bearer <execution-token>` and binds the report to that token in Postgres.

The default policy is an empty allowlist, so a new instance cannot contact any target until the administrator publishes at least one allow rule. The recommended global blacklist is an optional template, not an unconditional hard-coded policy. Direct recursion to the instance's own Control/Gateway origins is always rejected.

## Local setup

Requirements: pnpm 11.25, Docker, Deno 2.9.6, and the pinned Supabase CLI 2.116.0.

```bash
pnpm install --frozen-lockfile
node adapters/supabase/scripts/generate-env.mjs \
  --out adapters/supabase/supabase/functions/.env \
  --base-url http://127.0.0.1:54321/functions/v1
pnpm --filter @one-fetch/adapter-supabase start
```

`supabase start` automatically loads `supabase/functions/.env`. The generated
file is ignored and contains local secrets; remove it after testing. The checked
in `.env.example` documents names only and is not a valid cryptographic fixture.

Use the pnpm wrappers rather than invoking `supabase start` or
`supabase functions serve` directly. The wrappers first build each Function as
one self-contained ESM entrypoint under its ignored `.one-fetch-bundle/`
directory. Local runtime and hosted deployment therefore consume the same
artifact, while the Supabase CLI only bind-mounts the functions directory
instead of every workspace package file. Each staged artifact is syntax-checked,
its dependency graph may contain only the generated file and `node:` runtime
built-ins, and its SHA-256 is recorded in an adjacent generated manifest.

Supabase injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; do not place a real service-role key in Git. Both functions set `verify_jwt = false` because one-fetch owns its opaque admin and execution-token authentication. Internal tables are in the non-exposed `one_fetch` schema; public RPC wrappers revoke access from `public`, `anon`, and `authenticated`, then grant only `service_role`.

Run checks:

```bash
pnpm --filter @one-fetch/adapter-supabase typecheck
pnpm --filter @one-fetch/adapter-supabase test
pnpm --filter @one-fetch/adapter-supabase db:lint
pnpm --filter @one-fetch/adapter-supabase test:integration
```

Every migration embeds one `self-zeroed-sha256-v1` checksum. The checksum is
SHA-256 over the exact UTF-8 file bytes after replacing only the two embedded
checksum values (the marker and database insert) with 64 ASCII zeroes. A
detached generated manifest also records each final file's ordinary byte-for-byte
SHA-256, byte length, full filename, and normalized checksum. This avoids the
impossible requirement for a file to contain its own raw hash while still
detecting changes to every other byte and supporting future migrations.

Create a new migration with two zero placeholders, then explicitly regenerate
and review the migration plus both generated files:

```bash
pnpm --filter @one-fetch/adapter-supabase sync:migrations
pnpm --filter @one-fetch/adapter-supabase check:migrations
```

Normal build, test, startup, and CI paths only check; they never repair stale
generated files. Health compares the database's exact ordered normalized
checksum list with the bundled manifest and fails closed on missing, changed,
reordered, or unknown versions. This is an application compatibility ledger,
not independent proof of the historical bytes executed by Postgres and not a
substitute for schema-drift or backup-restore checks.

Each function has its own `deno.json` and `deno.lock`. Runtime imports map shared packages to built JavaScript, so Supabase never depends on development-only sloppy `.js` to `.ts` resolution. Adapter-local types are inferred from the same runtime Zod schemas, keeping those imports in lockstep with the deployed values. The build also validates the canonical Control OpenAPI 3.1 document and embeds a generated, bundle-local snapshot; the deployed function never reads outside its bundle. `GET /api/v1/openapi.json` overlays that canonical snapshot with the complete, validated `ONE_FETCH_CONTROL_BASE_URL` and the Supabase Preview's permanent `501` TOTP responses. Request and forwarded headers cannot override this URL. The overlay does not change the cross-adapter canonical document.

## Safe deployment

Generate a new secrets file outside the repository:

```bash
node scripts/generate-env.mjs --out /secure/path/one-fetch.env --project-ref abcdefghijklmnopqrst --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --admin-origin https://admin.example
```

The command creates the file exclusively and refuses to overwrite it. It includes the one-time bootstrap secret, token pepper, and an Ed25519 audit key pair. Do not print, upload, or commit it. A protected disaster-recovery copy is mandatory: losing the pepper or signing key breaks account/token validation or audit-chain continuity.

The 0.1 Preview deployment script is read-only unless `--apply`/`-Apply` is
explicit:

```bash
./scripts/deploy.sh --project-ref abcdefghijklmnopqrst \
  --env-file /secure/path/one-fetch.env \
  --expected-current-build 0.1.0+supabase.g0123456789ab \
  --db-password-file /secure/path/database-password
```

```powershell
./scripts/deploy.ps1 -ProjectRef abcdefghijklmnopqrst `
  -EnvFile C:\secure\one-fetch.env `
  -ExpectedCurrentBuild 0.1.0+supabase.g0123456789ab `
  -DatabasePasswordFile C:\secure\database-password
```

For a first deployment pass `none`; it is accepted only when neither Function
exists. The planner validates the complete environment-file schema without
printing values, runs the full local gate, embeds the exact commit build ID in
both self-contained bundles, records their SHA-256 values, strictly inventories
the project and current pair, creates and validates an isolated IPv4 pooler link,
runs `db push --linked --dry-run --skip-vault`, and records the provider backup
summary. It rejects a dirty Git tree and removes the transient link state on
success or failure. All hosted Supabase CLI calls use that workdir, so project
discovery and Function operations do not leave `.temp` state in the checkout.

Use a project-scoped Supabase token with Project Settings Read, Backups Read,
Connection Pooling Read, API Keys Read, Edge Functions Read-Write, and Edge
Function Secrets Read-Write. The database password is required for planning as
well as apply. Planning accepts the restricted file shown above or an explicit
`SUPABASE_DB_PASSWORD` environment variable; apply requires the restricted file.
Neither secret is placed in command arguments, state files, reports, or logs.

The secret-free plan is created with exclusive permissions under the ignored
`artifacts/supabase-deployments/` directory. The guarded apply additionally
requires restricted service-role-key and database-password files. Updates also
require an admin-token file to pause Gateway. PostgreSQL owns the expiring
compare-and-swap lease; the tool creates and hashes a logical backup, applies
forward migrations, deploys Control and Gateway one at a time, verifies each
version transition and the running pair, then completes the lease. `--resume`
is a separate explicit choice. Build identity is embedded in each bundle and is
never assigned afterward through a mutable project Secret.

## Operational boundaries

- Application audit records never contain bodies, authorization, cookies, tokens, passwords, TOTP material, or private keys. Path/query and ordinary headers are redacted before signing.
- Supabase platform logs may still observe the outer Gateway path/query before application redaction. Operators must configure platform retention accordingly and disclose this to users.
- Authentication source throttles use the first `X-Forwarded-For` value supplied by the managed Supabase edge. A self-hosted proxy chain must overwrite client-supplied forwarding headers and preserve that same client-first contract; otherwise the adapter's source-rate-limit boundary is not supported.
- Data forwarding continues if only the audit append fails and the response is marked degraded. Authentication, configuration, policy, or quota storage failures fail closed.
- Execution reports expire after ten minutes. Burst and instance-wide aggregate quotas, scheduled cleanup, daily Merkle sealing, Webhook outbox delivery, TOTP enrollment/recovery, automated in-place database restore, and tunnel enablement are subsequent Preview milestones and must not be represented as complete by this adapter yet.
