# one-fetch

one-fetch is a transparent, self-hosted request gateway for xPanel. It keeps the
target method, path, query, binary body, repeated headers, Fetch options, status,
and response body visible while separating target responses from relay and
provider failures.

> **Status:** [v0.1.0 Preview](https://github.com/OKFred/one-fetch/releases/tag/v0.1.0)
> is publicly available as a pre-release, not a stable release or a hosted
> service. No one-fetch service is operated by OKFred. xPanel 2.1 still uses its
> existing Relay protocol; one-fetch integration is a separate future update.

## Why two URLs?

- **Control URL** exposes the versioned `/api/v1/*` administration API.
- **Gateway URL** reserves no target path. The path and query appended by xPanel
  are forwarded as the target path and query.

The Gateway receives signed protocol metadata for the target origin, ordered
headers, Fetch options, policy context, nonce, and request ID. It returns the
real target status and body. Signed response metadata identifies a target
response or a one-fetch error; missing or invalid metadata identifies a CDN,
provider, proxy, or other intermediary response.

## Safety defaults

- A new instance starts with an **empty allowlist**. It cannot contact a target
  until its administrator adds an explicit allow rule.
- The recommended global blocklist is an optional template. It is never silently
  installed or hard-coded as policy. Administrators decide whether to use it.
- System policy runs before an optional xPanel user blocklist. User rules can
  only restrict a request further.
- Bodies, credentials, cookies, tokens, passwords, TOTP data, recovery codes,
  certificates, and private keys never enter the application audit ledger.
- Control and Gateway must use separate HTTPS origins in production.
- Provider-specific headers can be added, removed, normalized, or merged. Each
  adapter reports known mutations and timing limitations through capabilities.

## Workspace

```text
apps/admin/              Vue administration UI
adapters/cloudflare/     Control Worker, Gateway Worker, D1 and Durable Objects
adapters/supabase/       Control/Gateway Edge Functions and PostgreSQL migrations
adapters/node/           Node Control/Gateway listeners and SQLite storage
packages/protocol/       Runtime-validated protocol and JSON Schema source
packages/core/           Runtime-neutral policy, crypto and audit primitives
packages/client/         Typed Control, Gateway and tunnel clients
packages/conformance/    Cross-adapter fixtures and black-box assertions
tools/release/           Reproducible review-artifact and supply-chain checks
```

The workspace is ESM-only and uses pnpm, strict TypeScript project references,
native Fetch/Streams, and Zod runtime validation. Gateway code does not use a Web
framework; Hono is limited to Control APIs.

## Local verification

Requirements are Node.js `>=24.20.0 <27` and Corepack. Production should use
Node 24 LTS; CI additionally exercises Node 26.

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm check
```

Adapter-specific checks and environment requirements are in the
[support matrix](docs/support-matrix.md) and [operations index](docs/operations/README.md).

## Documentation

- [Architecture and wire behavior](docs/architecture.md)
- [Technology baseline](docs/technology.md)
- [Security model and policy defaults](docs/security.md)
- [Privacy statement](docs/privacy.md)
- [Permissions and network access](docs/permissions.md)
- [Audit ledger and alerts](docs/audit.md)
- [Supply-chain controls](docs/supply-chain.md)
- [Backup and restore](docs/operations/backup-restore.md)
- [Preview-to-1.0 release process](docs/release.md)
- [xPanel integration boundary](docs/xpanel-integration.md)
- [Control OpenAPI 3.1](docs/api/control.openapi.json)

## Distribution

one-fetch packages are not published to npm. The public Preview Release contains
fixed-version protocol/client archives, JSON Schemas, Control OpenAPI,
TypeScript declarations, a portable Node ESM archive and digest-pinned OCI build
inputs, checksums, an SBOM, and GitHub provenance. CI and the manual artifact
workflow do not deploy an adapter, push an image, or create a GitHub Release.

The [public download verification guide](docs/release.md#public-download-verification)
checks the annotated tag, downloaded bytes, manifest, and both checksum lists.
Published assets and tags must never be replaced in place.

## License

[MIT](LICENSE) © 2026 OKFred
