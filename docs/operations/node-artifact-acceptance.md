# Node archive and OCI acceptance

This local acceptance runs the downloaded build, not the checkout's Node
adapter. It does not deploy a public Gateway, modify a host database, publish a
Release, or prove a hosted deployment. Use Node 24.20.0 and a Docker Engine with
multi-platform OCI image-store support (`docker image inspect --platform`).

## Verify the exact CI input

Download the entire review artifact from the successful **push** workflow for
the chosen full commit. PR workflows may identify their synthetic merge commit
instead. Keep failed and successful receipts at different paths.

```sh
gh run download <push-run-id> --name one-fetch-0.1.0-review \
  --dir .tools/acceptance/ci-<commit>-review
pnpm --filter @one-fetch/conformance... build
docker load --input \
  .tools/acceptance/ci-<commit>-review/one-fetch-node-0.1.0.oci.tar
```

Pass the loaded OCI index digest explicitly. The runner checks the exact flat
file inventory, every manifest subject, SHA-256/SHA-512 lists, archive paths,
portable build metadata, and OCI index digest before creating a container. It
also checks the selected image's version/source/revision labels and non-root
user. These checks bind the supplied bundle internally; they **do not replace
GitHub attestation verification**. Receipts keep `provenanceVerified: false`.

## Exercise both distributions

```sh
node tools/acceptance/node-artifact-runtime.mjs \
  --directory .tools/acceptance/ci-<commit>-review \
  --commit <full-40-character-source-commit> --version 0.1.0 \
  --image sha256:<oci-index-digest> \
  --platform linux/amd64 --mode oci \
  --output .tools/acceptance/node-<commit>-oci-amd64.json
```

Repeat with `--mode archive` and a new output path. Archive mode extracts the
verified portable tarball into container tmpfs and starts **that** CLI, not the
OCI application's entrypoint. Repeat OCI mode with `--platform linux/arm64`
where supported. An ARM64 container on an x64 Docker host is emulated acceptance,
not a native ARM64 hardware test. A missing platform or emulator fails; it never
silently falls back to AMD64. Do not run acceptance commands concurrently with
source edits or generated-file builds; the receipt identifies the runner commit
and dirty checkout independently of the artifact commit.

Each run uses:

- One random, ownership-labelled container; Control/Gateway are published only
  on ephemeral `127.0.0.1` ports. The synthetic target is container-local.
- UID 1000, read-only root, no added capabilities, no-new-privileges, bounded
  memory/PIDs, private tmpfs state, and disabled Docker container logging.
- Fresh bootstrap/admin/execution credentials, with no runner-created host
  credential files or databases. Signing keys and instance secrets enter via
  container environment variables; Docker stores those in container metadata
  and Docker administrators can inspect them until container removal. Bootstrap
  and database state use tmpfs; admin/session/execution tokens stay in the runner.
- Bootstrap, session refresh/logout/login, empty default allowlist, an explicit
  synthetic target rule, all HTTP conformance fixtures, execution-token
  revocation, and audit event signature/credential-canary verification.

Fixtures include transparent path/query handling, request bodies, target error
statuses, repeated `Set-Cookie`, `Server-Timing`, 20 MiB and 20 MiB + 1, timeout,
cancellation, and partial-download reports. The suite's timeout/cancellation
checks are client-visible observations; they do not establish every upstream
socket deadline or native TLS/CA behavior. Separate Node integration tests and
deployment/restore rehearsals remain necessary.

## Read failure and cleanup evidence

The CLI exits nonzero unless all runtime, HTTP, authentication, audit, and
cleanup checks pass. A successful HTTP subreport alone is not an overall pass.
The sanitized failure phase identifies the failed stage; completed HTTP results
are retained if a later revocation or audit check fails. Receipts never contain
request bodies, raw upstream headers, tokens, or raw subprocess errors.

The `finally` cleanup resolves the exact random container name to its full ID,
checks the ownership label, removes only that container, and independently
confirms absence. This also covers an ambiguous create-command failure. If
ownership/inventory/removal verification fails, the receipt says cleanup failed;
do not use `docker system prune` as a substitute. Output paths refuse overwrite.

Loaded OCI images are not deleted automatically: they are non-secret caches and
may be shared. No other containers, volumes, images, pre-existing temporary
directories, or cloud resources are touched.

Early invalid/revoked execution-token denials are signed when valid request
metadata, a presented token and a real configuration version are available.
Missing bindings or configuration-store failure remain unsigned, fail closed,
and appear as unverified/intermediary results. The runner rejects an unsigned
revoked-token response when configuration is healthy.
