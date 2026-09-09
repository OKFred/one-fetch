# one-fetch Node adapter

The Node adapter runs two independent listeners: the Hono Control API and the transparent native HTTP Gateway. It requires Node `>=24.20.0 <27` and refuses to start if the built-in `node:sqlite` probe or database integrity check fails.

Copy `.env.example` into your secret manager or service configuration. Do not commit a populated `.env`. Generate an Ed25519 PKCS#8 key and independent random instance/protocol secrets before first start.

```bash
pnpm --filter @one-fetch/adapter-node build
node adapters/node/dist/cli.js
```

The initial process prints a one-time bootstrap token. The token is stored only as a digest and cannot be recovered later. The default system policy is an empty allowlist, so execution tokens cannot reach any target until an administrator adds explicit allow rules.

Target response headers, including repeated `Set-Cookie`, are transported inside signed one-fetch response metadata. They are never applied to the Gateway origin. DNS, TCP, TLS, TTFB and target-provided `Server-Timing` are reported when measurable; connection reuse or proxying can make individual phases unavailable.

The `0.1 Preview` runtime exposes only HTTP. WebSocket, TCP, and TLS tunnel
capabilities are reported as `unsupported`, and protocol upgrades are rejected
before any target connection is opened. Dormant tunnel modules are retained for
future conformance work but are not registered by the shipped server.

## SQLite migrations

`migrations/` is the append-only source of the SQL executed by the database
worker. `migration-manifest.json` records every complete filename, byte length,
and raw SHA-256 digest; the generated TypeScript module embeds those exact SQL
bytes for runtime use. The first seven files intentionally preserve the former
template-string whitespace byte for byte so existing database ledger checksums
remain compatible.

Normal build, typecheck, and test commands verify the checked-in artifacts but
never rewrite them. After adding the next contiguous `NNNN_lowercase_name.sql`
file, explicitly generate and review both outputs:

```bash
pnpm --filter @one-fetch/adapter-node migrations:generate
pnpm --filter @one-fetch/adapter-node migrations:check
```

Generation refuses to change, rename, reorder, or delete any migration already
recorded in the manifest. Migration files must be regular, BOM-free UTF-8 files;
an unknown database version or a checksum mismatch still prevents startup.

## Portable ESM archive and OCI image

The release builder creates `one-fetch-node-<version>.tar.gz` with the compiled
ESM runtime, migrations, license, and all production dependencies. It does not
need `pnpm install` after extraction and contains no adapter tests or TypeScript
source. Build it only after `pnpm install --frozen-lockfile` and the workspace
build have completed. Artifact assembly performs no dependency resolution or
network access: it verifies that the installed virtual-store lock exactly
matches `pnpm-lock.yaml`, then runs the installed, validated pnpm 11.25.0 with
shared-lockfile deploy, frozen/offline/read-only-store mode, workspace
injection, and scripts disabled. The validated content-store path is passed
explicitly, so packaging does not depend on pnpm's registry metadata cache,
modify the store, or silently select a store on another drive.

```bash
node tools/release/build-node-distribution.mjs --version 0.1.0
```

The same release directory contains a versioned Dockerfile and OCI build
metadata. The Dockerfile consumes that exact archive, runs as the built-in
`node` user, restricts its context with a Dockerfile-specific ignore file, and
pins both its frontend and the multi-platform `node:24.20.0-bookworm-slim` image
by OCI index digest. Build an OCI layout locally without pushing it:

```bash
cd artifacts/release/0.1.0
docker buildx build \
  --file one-fetch-node-0.1.0.Dockerfile \
  --build-arg ONE_FETCH_VERSION=0.1.0 \
  --build-arg VCS_REF="$(git rev-parse HEAD)" \
  --platform linux/amd64,linux/arm64 \
  --output type=oci,dest=one-fetch-node-0.1.0.oci.tar \
  .
```

Mount `/var/lib/one-fetch` as the only writable data directory and inject all
secrets at runtime. Never bake an `.env` file or plaintext secret into either
artifact.
