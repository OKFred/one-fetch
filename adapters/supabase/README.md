# one-fetch Supabase adapter

This adapter runs one-fetch as two independently deployed Supabase Edge Functions backed by Postgres:

- `one-fetch-control` exposes canonical `/api/v1/*` routes for bootstrap, authentication, capabilities, configuration, execution tokens, audit queries, and short-lived reports.
- `one-fetch-gateway` treats every path after the function base URL as the target path. It does not reserve `/v1`, `/api`, or another target path.

Supabase itself necessarily reserves `/functions/v1/one-fetch-gateway` to select the Edge Function. Configure that complete URL as the Gateway base; everything appended by xPanel is preserved as the target path/query.

## Preview capabilities

HTTP uses native Fetch and Web Streams. It validates the shared one-fetch protocol, preserves the target status/body, carries repeated `Set-Cookie` values in signed metadata, applies system and user policy rules, enforces per-token fixed-minute/concurrency/daily-byte quotas, supports cancellation and 60-second default timeouts, and writes redacted signed audit records. Responses stream; Preview request bodies are buffered up to the 20 MiB protocol limit so their declared size/hash and body policy can be verified before forwarding. Target `Set-Cookie` is never emitted against the Supabase hostname.

Supabase can add or rewrite transport headers, merge ordinary duplicate headers, decode content encoding, and add response headers. The adapter may also merge ordinary duplicate request fields while materializing native `Headers`; explicit Cookie fields are joined deliberately. Capabilities and xPanel must present those mutations. The runtime does not expose separate DNS, TCP, or TLS timings; they are reported as unavailable rather than zero. Target `Server-Timing` is retained separately.

WebSocket and outbound TCP/TLS are reported as `unsupported` in the Preview adapter. They must not be advertised as enabled until their shared tunnel protocol and a deployment runtime probe pass. Edge Function wall-clock/runtime limits still apply to WebSocket sessions even after a future capability is enabled.

Canonical Control paths are `/api/v1/config`, `/api/v1/config/policy`, `/api/v1/tokens/execution`, `/api/v1/audit`, `/api/v1/alerts`, `/api/v1/backups`, and `/api/v1/reports/:reportId`. Alerts and backups return an explicit Preview `unsupported` response; they never return synthetic data. Capabilities, health, and report lookup permit configured client origins; all other Control routes permit only configured admin origins. Report lookup uses `Authorization: Bearer <execution-token>` and binds the report to that token in Postgres.

The default policy is an empty allowlist, so a new instance cannot contact any target until the administrator publishes at least one allow rule. The recommended global blacklist is an optional template, not an unconditional hard-coded policy. Direct recursion to the instance's own Control/Gateway origins is always rejected.

## Local setup

Requirements: pnpm 11.25, Docker, Deno 2.9.6, and the pinned Supabase CLI 2.116.0.

```bash
pnpm install --frozen-lockfile
pnpm --filter @one-fetch/adapter-supabase start
cp adapters/supabase/supabase/.env.example adapters/supabase/supabase/.env.local
pnpm --filter @one-fetch/adapter-supabase functions:serve
```

Supabase injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; do not place a real service-role key in Git. Both functions set `verify_jwt = false` because one-fetch owns its opaque admin and execution-token authentication. Internal tables are in the non-exposed `one_fetch` schema; public RPC wrappers revoke access from `public`, `anon`, and `authenticated`, then grant only `service_role`.

Run checks:

```bash
pnpm --filter @one-fetch/adapter-supabase typecheck
pnpm --filter @one-fetch/adapter-supabase test
pnpm --filter @one-fetch/adapter-supabase db:lint
pnpm --filter @one-fetch/adapter-supabase test:integration
```

Each function has its own `deno.json` and `deno.lock`. The configs pin npm dependencies and map shared one-fetch packages to repository sources; `--frozen` prevents an unexpected dependency update. The Supabase bundler packages the resulting local module graph during deployment.

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

They link the explicit project, push migrations, set secrets, and deploy Control before Gateway. They do not create a project, publish a Release, or modify xPanel.

## Operational boundaries

- Application audit records never contain bodies, authorization, cookies, tokens, passwords, TOTP material, or private keys. Path/query and ordinary headers are redacted before signing.
- Supabase platform logs may still observe the outer Gateway path/query before application redaction. Operators must configure platform retention accordingly and disclose this to users.
- Data forwarding continues if only the audit append fails and the response is marked degraded. Authentication, configuration, policy, or quota storage failures fail closed.
- Execution reports expire after ten minutes. Burst and instance-wide aggregate quotas, scheduled cleanup, daily Merkle sealing, Webhook outbox delivery, TOTP enrollment/recovery, backup/restore, and tunnel enablement are subsequent Preview milestones and must not be represented as complete by this adapter yet.
