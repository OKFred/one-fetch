# Cloudflare adapter

This adapter deploys two independent Workers:

- `one-fetch-control` serves the Hono Control API, D1 storage, authentication,
  audit records, reports, and the Auth/Quota Durable Objects.
- `one-fetch-gateway` preserves the target path/query and streams requests to
  the target. It reaches Control through a named Service Binding.

## Preview capability boundary

HTTP is stable in the adapter and WebSocket is experimental. WebSocket clients
must negotiate only `one-fetch.v1`, then send `TunnelClientHelloV1` as the first
text frame. The Worker authenticates and evaluates policy before opening the
target socket; its first response frame is the signed `TunnelServerHelloV1`.

TCP and TLS tunnels remain `unsupported` in `0.1`. Cloudflare exposes outbound
sockets, but these transports stay disabled until the adapter has runtime probes,
DNS-rebinding coverage, byte-level backpressure tests, and real-environment
conformance evidence. Capabilities must not be changed before that work exists.

Cloudflare Fetch does not expose separate target DNS, TCP-connect, or TLS timing.
Those phases are explicitly reported as unavailable. Gateway-observed auth,
policy, TTFB, and total time are measured, while target `Server-Timing` metrics
are preserved separately. Cloudflare may add or normalize vendor headers such as
`Accept-Encoding`, `CF-Connecting-IP`, `X-Forwarded-For`, `CF-Ray`, and `Server`;
the capability response advertises these possible mutations.

Persistent Workers observability is disabled in both Wrangler configurations.
The application audit ledger is stored in D1, redacts secrets, and never records
request or response bodies, Cookie, Set-Cookie, Authorization, passwords, TOTP,
recovery codes, certificates, or private keys.

## Local checks

Copy `.dev.vars.example` to `.dev.vars` and replace every value. Then run:

```sh
pnpm --filter @one-fetch/adapter-cloudflare migrations:check
pnpm --filter @one-fetch/adapter-cloudflare types:check
pnpm --filter @one-fetch/adapter-cloudflare test
pnpm --filter @one-fetch/adapter-cloudflare typecheck
pnpm --filter @one-fetch/adapter-cloudflare build
pnpm --filter @one-fetch/adapter-cloudflare check:startup
```

`migration-manifest.json` records each ordered migration's exact byte length,
raw SHA-256 artifact digest, and runtime compatibility digest. Migrations
`0001` through `0003` remain byte-for-byte immutable. Migration `0004` creates
`one_fetch_migrations` and records those three raw digests plus its own
self-normalized digest. Every later migration appends exactly one row for itself.

Self-normalized migrations contain one marker and one canonical ledger `INSERT`
with the same checksum. `self-zeroed-sha256-v1` replaces only those two 64-byte
checksum fields with ASCII zeroes, then hashes the complete UTF-8 SQL bytes,
including line endings. A new migration starts with zero placeholders; finalize
it once its SQL is ready, then review the SQL and both generated manifests:

```sh
pnpm --filter @one-fetch/adapter-cloudflare migrations:generate
pnpm --filter @one-fetch/adapter-cloudflare migrations:check
```

Generation is append-only: it refuses to rewrite any migration already present
in the manifest. The read-only check rejects renamed, missing, extra, reordered,
non-contiguous, byte-modified, or stale generated files. It runs before tests,
Control development startup, startup profiling, builds, and guarded migration
apply commands.

Control checks the primary D1 ledger before every HTTP request, scheduled task,
and Service Binding data-plane call. Gateway therefore fails before quota or
target-network work when the ledger is old, missing, longer, reordered, or has a
different digest. This compatibility ledger proves only that D1 contains the
declared ordered records. It does not prove the historical SQL bytes that were
executed and does not detect arbitrary schema drift; backup/restore and schema
verification remain separate acceptance work.

Normal `build` and `typecheck` commands only verify checked-in Wrangler binding
types. Regenerate them deliberately after a binding or exported RPC change:

```sh
pnpm --filter @one-fetch/adapter-cloudflare types:generate
pnpm --filter @one-fetch/adapter-cloudflare types:check
```

Production is pinned to compatibility date `2026-09-04`. Wrangler 4.128.0's
local startup profiler bundles an older workerd, so the startup-only bundle uses
`2026-08-22`; production dry-runs still validate the pinned production date.

## Deployment inputs

Control requires one D1 database and four Wrangler secrets:

- `BOOTSTRAP_SECRET`
- `INSTANCE_PEPPER`
- `ENCRYPTION_KEY` (32 random bytes, Base64URL encoded)
- `AUDIT_SIGNING_KEY` (Ed25519 PKCS#8, Base64URL encoded)

Apply `migrations/` before starting Control. The package exposes integrity-gated
Wrangler commands for deliberate local or remote application:

```sh
pnpm --filter @one-fetch/adapter-cloudflare migrations:apply:local
pnpm --filter @one-fetch/adapter-cloudflare migrations:apply:remote
```

Deploy Control before Gateway so the named `ControlService` binding resolves.
Deployment is intentionally not part of the package checks and no cloud
resources are created automatically by tests.
