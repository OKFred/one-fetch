# Node deployment runbook

## Boundary

The Node adapter supports one process with separate Control and Gateway
listeners. It requires Node `>=24.20.0 <27`; production defaults to Node 24 LTS.
It uses built-in `node:sqlite` in a dedicated Worker Thread and refuses startup
when runtime, schema, or integrity probes fail. Multi-replica operation is not
supported in 1.0.

## Prepare

1. Create a non-root service account and a private data directory.
2. Install the immutable source revision and Node 24 LTS, or extract the
   versioned portable Node archive. The archive already includes production
   dependencies and must be verified against the release checksums/provenance.
3. For a source installation, run `corepack pnpm install --frozen-lockfile` and
   `corepack pnpm --filter @one-fetch/adapter-node build`.
4. Generate independent high-entropy instance pepper and protocol key, plus an
   Ed25519 PKCS#8 audit key. `pnpm deploy:node:secrets -- --output
/run/secrets/one-fetch-node.json` creates a non-overwriting private JSON file
   with the required environment-variable names. Import it into the service
   secret store and retain the same values for restarts and disaster recovery.
5. Set the variables documented in `adapters/node/.env.example`. Keep Control
   and Gateway on separate loopback ports behind separate TLS virtual hosts.
6. Restrict `ONE_FETCH_CONTROL_ALLOWED_ORIGINS` to the deployed Admin origin.

The public URLs must be the externally visible HTTPS origins, not loopback. Do
not expose the SQLite file, environment, debug endpoint, or source maps through
the reverse proxy.

## Versioned install and update helper

Verify the release checksums, then run the version-matched deployment helper in
plan mode. A first install must explicitly state that no version is expected:

```sh
node one-fetch-node-deploy-0.1.0.mjs \
  --mode plan \
  --root /opt/one-fetch \
  --archive one-fetch-node-0.1.0.tar.gz \
  --sha256 <archive-sha256> \
  --expected-version none
```

Repeat with `--mode apply` after reviewing the plan. The helper validates the
archive digest and paths, installs under `versions/<version>`, and atomically
writes `current.json`. Start the selected build through the same helper:

```sh
node one-fetch-node-deploy-0.1.0.mjs --mode launch --root /opt/one-fetch
```

For an update, pass the exact active version plus the Control URL and a private
administrator-token file. The helper pauses Gateway through Control, makes and
integrity-checks a live SQLite backup, retains the previous artifact, switches
the pointer, and writes a restricted deployment journal. It never restores a
database automatically.

```sh
node one-fetch-node-deploy-0.1.0.mjs \
  --mode apply \
  --root /opt/one-fetch \
  --archive one-fetch-node-0.1.0.tar.gz \
  --sha256 <archive-sha256> \
  --expected-version <active-version> \
  --control-url https://control.example \
  --admin-token-file /run/secrets/one-fetch-admin
```

Restart the service, then run `--mode verify` with the Control URL. Add
`--resume` and the token file only after the running build matches
`current.json`. Binary rollback uses `--mode rollback --expected-version
<active-version>` and keeps Gateway paused. It refuses rollback when the older
artifact cannot read the current schema; restore the recorded backup into a new
database path and verify it separately instead.

## Start and bootstrap

```bash
node adapters/node/dist/cli.js
```

Capture the one-time bootstrap secret without logging it. Bootstrap one
administrator over the Control HTTPS origin, enroll MFA when supported by the
active capabilities, and destroy the plaintext bootstrap copy. The initial
empty allowlist should make a synthetic target request fail closed.

For supervised or acceptance starts, set `ONE_FETCH_BOOTSTRAP_TOKEN_FILE` to a
new path in the private data directory. The CLI creates that file with private
permissions, refuses to overwrite it, and logs only its path. If the variable
is omitted, the token is printed for an attended interactive bootstrap.

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

The release bundle supplies a Dockerfile and OCI metadata tied to the portable
archive. Its build context is the release-version directory, not the repository
root, so source, local dependencies, and secret files cannot enter the image
context. Pass the exact version and source commit as build arguments, verify the
recorded base-image index/platform digests, and create the OCI output without
`--push` until the image has passed this runbook's acceptance checks. The
Dockerfile-specific ignore file limits the build context to the named Node
archive; keep it beside the versioned Dockerfile when building.
