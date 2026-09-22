# Node cross-version archive rehearsal

Run this separately from the single-build HTTP conformance suite. It uses two
real portable archives and the **candidate's** packaged deployment helper;
neither archive is relabelled. It never upgrades a host installation or restores
a database in place. Docker must already be running.

## Inputs

Obtain the old archive and OCI metadata from the published release. Verify the
release asset digests and attestations separately. Build/download the candidate
archive, OCI metadata and helper from the same clean commit. The runner checks
both archive hashes, versions, package identities, safe tar paths, clean-source
metadata and candidate helper hash. These checks do not prove provenance.

```sh
node tools/acceptance/node-upgrade-runtime.mjs \
  --from-archive <old-directory>/one-fetch-node-0.1.0.tar.gz \
  --from-metadata <old-directory>/one-fetch-node-oci-0.1.0.json \
  --to-archive <candidate-directory>/one-fetch-node-0.1.1.tar.gz \
  --to-metadata <candidate-directory>/one-fetch-node-oci-0.1.1.json \
  --helper <candidate-directory>/one-fetch-node-deploy-0.1.1.mjs \
  --image sha256:<locally-loaded-Node-24.20.0-image-index> \
  --platform linux/amd64 \
  --output .tools/acceptance/upgrade-<unique-run>.json
```

Use the digest-pinned Node image from `adapters/node/oci-build.json`, not a
floating tag. Repeat on `linux/arm64` if available, describing emulation as
emulation. Output receipts refuse overwrite. Failed receipts remain failed.

## What this exercises

- First-install the actual old archive; start its packaged server and bootstrap
  a synthetic account, persistent session, policy and two execution tokens.
- Forward a POST with body, repeated query keys, duplicate Set-Cookie and
  Server-Timing. Verify target signatures and revoked-token denial. The old
  0.1.0 unsigned-denial behavior is not misrepresented as fixed after rollback.
- Reject stale expected versions and bad hashes before pausing traffic.
- Inject a real activation rename failure with a read-only versions directory:
  keep the old pointer and paused Gateway, then explicitly verify/resume it.
- Run the real update: authenticated pause, SQLite backup/digest, pointer
  activation, rejected stale-runtime resume, new packaged server startup,
  identity verification and explicit resume.
- Roll back code without database restoration; require verification before
  resuming the old server. Preserve original policy/session/revocation and
  compare every original audit record while verifying final signatures.

All listeners and the synthetic target are inside a `--network none` container.
No host ports are published. The runner uses UID 1000, a read-only root, private
tmpfs, disabled Docker logs and bounded memory/PIDs. Secrets are generated in
the container process, not placed in host files, Docker arguments or container
environment metadata. The temporary administrator token file is mode 0600 in
tmpfs and removed on exit. Container administrators still control the runtime.
Cleanup checks the exact container's ownership label, removes it and confirms
absence; no global pruning is used. Loaded non-secret images are retained.

## Interrupted-upgrade variant

Add `--scenario interrupted` with a new output receipt to run five real helper
process terminations against the two packaged servers: pause response lost,
backup verified, update pointer replaced, resume response lost, and rollback
pointer replaced. The candidate helper is copied byte-for-byte; only a separate
test child intercepts filesystem/Fetch calls to hold deterministic checkpoints.
The server keeps running while its deployment helper receives SIGKILL.

Each checkpoint confirms actual Control/Gateway behavior, historical journal
state and the selected pointer, then checks that all mutating retries are blocked.
Only inside the owned disposable `/tmp/installed` fixture, after the only helper
child has exited, the runner simulates an operator preserving the exact orphan
lock into `interruption-evidence/`. It verifies runtime identity before explicit
resume; it never adds force-unlock behavior to the production helper, restores a
database in place, or runs recovery against a host installation. Stale-runtime
resume is rejected both after update and rollback activation. Original sessions,
policy, token revocation and signed audit records must survive every checkpoint.

The receipt separates helper-process termination from **server-process** crash,
container/OS power loss, CLI/service-manager restart and schema-changing recovery;
the latter are not covered by this variant. Its source runner commit and the
CI artifact commit remain independent identities. Keep failed attempts as failed.

## Shared limits

The server is started via its packaged exported startup function, not its CLI
or a service manager. The standard scenario is not a process-kill test; neither
scenario establishes power-loss guarantees, a full-lifecycle
deployment lease, schema-changing rollback, independent Gateway handshake,
whole HTTP conformance suite, OCI application-entrypoint test, final release
acceptance or provenance verification. Those gates remain separate.
