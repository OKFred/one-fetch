# one-fetch Supabase adapter

This adapter runs one-fetch as two independently deployed Supabase Edge Functions backed by Postgres:

- `one-fetch-control` exposes canonical `/api/v1/*` routes for bootstrap, authentication, capabilities, configuration, execution tokens, audit queries, and short-lived reports.
- `one-fetch-gateway` treats every path after the function base URL as the target path. It does not reserve `/v1`, `/api`, or another target path.

Supabase itself necessarily reserves `/functions/v1/one-fetch-gateway` to select the Edge Function. Configure that complete URL as the Gateway base; everything appended by xPanel is preserved as the target path/query.

## Preview capabilities

HTTP uses native Fetch and Web Streams. It validates the shared one-fetch protocol, preserves the target status/body, carries repeated `Set-Cookie` values in signed metadata, applies system and user policy rules, enforces per-token fixed-minute/concurrency/daily-byte quotas, supports cancellation and 60-second default timeouts, and writes redacted signed audit records. Responses stream; Preview request bodies are buffered up to the 20 MiB protocol limit so their declared size/hash and body policy can be verified before forwarding. Target `Set-Cookie` is never emitted against the Supabase hostname.

Supabase can add or rewrite transport headers, merge ordinary duplicate headers, decode content encoding, and add response headers. The adapter may also merge ordinary duplicate request fields while materializing native `Headers`; explicit Cookie fields are joined deliberately. Capabilities and xPanel must present those mutations. The runtime does not expose separate DNS, TCP, or TLS timings; they are reported as unavailable rather than zero. Target `Server-Timing` is retained separately.

WebSocket and outbound TCP/TLS are reported as `unsupported` in the Preview adapter. They must not be advertised as enabled until their shared tunnel protocol and a deployment runtime probe pass. Edge Function wall-clock/runtime limits still apply to WebSocket sessions even after a future capability is enabled.

Canonical Control paths include `GET|POST /api/v1/bootstrap`, `/api/v1/auth/*`, `/api/v1/config/*`, `/api/v1/tokens/execution`, `/api/v1/audit`, `/api/v1/features`, `/api/v1/alerts`, `/api/v1/backups`, and `/api/v1/reports/:reportId`. Session listing/revocation, logout, password changes, policy updates, and Gateway pause are implemented; password changes revoke every other session in the same audited database transaction. TOTP, alerts, backups, audit export, and Webhooks remain explicitly `unsupported`; alerts and backups return their versioned feature-status envelopes instead of synthetic records. Capabilities, health, feature status, and report lookup permit configured client origins; all other Control routes permit only configured admin origins. Report lookup uses `Authorization: Bearer <execution-token>` and binds the report to that token in Postgres.

The default policy is an empty allowlist, so a new instance cannot contact any target until the administrator publishes at least one allow rule. The recommended global blacklist is an optional template, not an unconditional hard-coded policy. Direct recursion to the instance's own Control/Gateway origins is always rejected.

## Local setup

Requirements: pnpm 11.25, Docker, Deno 2.9.6, and the pinned Supabase CLI 2.116.0.

```bash
pnpm install --frozen-lockfile
pnpm --filter @one-fetch/adapter-supabase start
cp adapters/supabase/supabase/.env.example adapters/supabase/supabase/.env.local
pnpm --filter @one-fetch/adapter-supabase functions:serve
```

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

Each function has its own `deno.json` and `deno.lock`. Runtime imports map shared packages to built JavaScript, so Supabase never depends on development-only sloppy `.js` to `.ts` resolution. Adapter-local types are inferred from the same runtime Zod schemas, keeping those imports in lockstep with the deployed values. The build also validates the canonical Control OpenAPI 3.1 document and embeds a generated, bundle-local snapshot; the deployed function never reads outside its bundle. `GET /api/v1/openapi.json` overlays that canonical snapshot with the complete request-derived Edge Function base URL and the Supabase Preview's permanent `501` TOTP responses. It does not change the cross-adapter canonical document.

## Safe deployment

Generate a new secrets file outside the repository:

```bash
node scripts/generate-env.mjs --out /secure/path/one-fetch.env --project-ref abcdefghijklmnopqrst --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --admin-origin https://admin.example
```

The command creates the file exclusively and refuses to overwrite it. It includes the one-time bootstrap secret, token pepper, and an Ed25519 audit key pair. Do not print, upload, or commit it. Delete it after setting Supabase secrets, while retaining a protected disaster-recovery copy if desired.

Deployment scripts are dry-run by default and require `--apply`/`-Apply`:

```bash
./scripts/deploy.sh --project-ref abcdefghijklmnopqrst --env-file /secure/path/one-fetch.env --apply
```

```powershell
./scripts/deploy.ps1 -ProjectRef abcdefghijklmnopqrst -EnvFile C:\secure\one-fetch.env -Apply
```

Before any remote mutation, the scripts verify canonical and embedded OpenAPI freshness, run both Deno typechecks and test suites, run deployment-script tests, and stage clean self-contained bundles for both functions. Deployment rejects a dirty Git tree: the scripts inject `ONE_FETCH_BUILD_VERSION` as `package-version+supabase.g<12-character-commit>`, then verify Control health/capabilities and issue a metadata-free Gateway request that cannot reach an upstream target. The final checks require the expected instance pair/build and the Gateway's application-level `invalid_metadata` rejection. The scripts link the explicit project, push migrations, set secrets, and deploy Control before Gateway. They do not create a project, publish a Release, or modify xPanel.

## Operational boundaries

- Application audit records never contain bodies, authorization, cookies, tokens, passwords, TOTP material, or private keys. Path/query and ordinary headers are redacted before signing.
- Supabase platform logs may still observe the outer Gateway path/query before application redaction. Operators must configure platform retention accordingly and disclose this to users.
- Authentication source throttles use the first `X-Forwarded-For` value supplied by the managed Supabase edge. A self-hosted proxy chain must overwrite client-supplied forwarding headers and preserve that same client-first contract; otherwise the adapter's source-rate-limit boundary is not supported.
- Data forwarding continues if only the audit append fails and the response is marked degraded. Authentication, configuration, policy, or quota storage failures fail closed.
- Execution reports expire after ten minutes. Burst and instance-wide aggregate quotas, scheduled cleanup, daily Merkle sealing, Webhook outbox delivery, TOTP enrollment/recovery, backup/restore, and tunnel enablement are subsequent Preview milestones and must not be represented as complete by this adapter yet.
