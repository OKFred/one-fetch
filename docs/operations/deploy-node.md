# Node deployment runbook

## Boundary

The Node adapter supports one process with separate Control and Gateway
listeners. It requires Node `>=24.20.0 <27`; production defaults to Node 24 LTS.
It uses built-in `node:sqlite` in a dedicated Worker Thread and refuses startup
when runtime, schema, or integrity probes fail. Multi-replica operation is not
supported in 1.0.

## Prepare

1. Create a non-root service account and a private data directory.
2. Install the immutable source/artifact revision and Node 24 LTS.
3. Run `corepack pnpm install --frozen-lockfile` and
   `corepack pnpm --filter @one-fetch/adapter-node build`.
4. Generate independent high-entropy instance pepper and protocol key, plus an
   Ed25519 PKCS#8 audit key. Put them in the service secret store.
5. Set the variables documented in `adapters/node/.env.example`. Keep Control
   and Gateway on separate loopback ports behind separate TLS virtual hosts.
6. Restrict `ONE_FETCH_CONTROL_ALLOWED_ORIGINS` to the deployed Admin origin.

The public URLs must be the externally visible HTTPS origins, not loopback. Do
not expose the SQLite file, environment, debug endpoint, or source maps through
the reverse proxy.

## Start and bootstrap

```bash
node adapters/node/dist/cli.js
```

Capture the one-time bootstrap secret without logging it. Bootstrap one
administrator over the Control HTTPS origin, enroll MFA when supported by the
active capabilities, and destroy the plaintext bootstrap copy. The initial
empty allowlist should make a synthetic target request fail closed.

## Acceptance

Verify both externally and from the service network:

```text
GET <control>/api/v1/health
GET <control>/api/v1/capabilities
```

Then use synthetic endpoints to verify target 2xx and 5xx classification,
duplicate query/header behavior, `Set-Cookie`, `Server-Timing`, redirects,
timeout, cancellation, body limit, execution report, policy denial, audit
redaction, and the enabled tunnel/proxy/TLS capabilities. Confirm unsigned
reverse-proxy failures appear as intermediary results.

## Upgrade and rollback

Take and verify an offline backup, stop traffic, stop the process, and apply only
forward migrations supplied by the new revision. Unknown newer schemas abort
startup. After acceptance, retain the previous artifact and backup for the
defined rollback window.

Do not run old code against a migrated database unless the release notes
explicitly support it. Rollback means restoring the pre-upgrade database into a
new file, starting the prior immutable artifact, and re-running acceptance. Log
the migration/restore in the audit trail and operator change record.

Use service-manager restart limits, a read-only application directory, a private
writable data directory, memory/CPU/file descriptor limits, egress firewall
rules, and TLS timeouts. Container deployments should run a digest-pinned Node 24
image as non-root and mount only the data directory and secrets.
