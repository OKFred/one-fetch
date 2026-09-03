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
pnpm --filter @one-fetch/adapter-cloudflare test
pnpm --filter @one-fetch/adapter-cloudflare typecheck
pnpm --filter @one-fetch/adapter-cloudflare build
pnpm --filter @one-fetch/adapter-cloudflare check:startup
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

Apply `migrations/` before starting Control. Deploy Control before Gateway so the
named `ControlService` binding resolves. Deployment is intentionally not part of
the package checks and no cloud resources are created automatically by tests.
