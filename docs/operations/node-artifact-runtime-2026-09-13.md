# Node CI archive and OCI runtime acceptance — 2026-09-13

## Result and exact builds

The downloaded **push CI** review bundle for
`b518bb17c2967e76e3d35e2f42158b1e82a4440e` passes real portable-archive and OCI
runtime acceptance. The runner was the clean commit
`a57b579a166c9f58b76e73b05fb8af0f0803f8e2`. These are different identities,
recorded independently; later documentation is not relabelled as the tested
artifact. This does not replace or publish the existing `v0.1.0` Release.

| Distribution           | Runtime                              | HTTP fixtures | Revoked-token result        | Verified audit events |
| ---------------------- | ------------------------------------ | ------------- | --------------------------- | --------------------- |
| Portable archive       | Node 24.20.0, Linux AMD64            | 18/18         | Signed Relay `unauthorized` | 40                    |
| OCI default entrypoint | Node 24.20.0, Linux AMD64            | 18/18         | Signed Relay `unauthorized` | 40                    |
| OCI default entrypoint | Node 24.20.0, Linux ARM64 (emulated) | 18/18         | Signed Relay `unauthorized` | 39                    |

Each run bootstraps a fresh account, exercises refresh/logout/login and sessions,
verifies the empty default allowlist, and installs only a synthetic loopback
target rule. All 119 returned audit signatures verify; credential canaries are
absent. Per-run event counts are observations, not a fixed success threshold or
proof that every possible audit lifecycle event was emitted.

The 18 HTTP cases cover target path/query spelling, JSON/form/multipart bodies,
target 401/429/503, manual redirect, repeated `Set-Cookie`, `Server-Timing`,
streaming, 20 MiB/20 MiB + 1, timeout, cancellation and partial-download reports.
No target Header values or response bodies appear in the published evidence.

## Defect found in the previous artifact

The older `24de50516b884f296ea84edf76f3d6fcab28eb29` CI image passed all 18 HTTP
cases on AMD64 and emulated ARM64, **but overall acceptance failed**: after
revocation, Node emitted an unsigned 401, classified as `intermediary`.
Authentication rejection happened before configuration was loaded, leaving no
configuration version for the response signer. Original failed receipts remain
unchanged and their hashes are preserved in the evidence.

Commit `9abeaaf` obtains the real configuration after validating request binding
and before execution-token authentication. Invalid/revoked credentials now
produce signed Relay errors, without granting access or opening an upstream
connection. Six regression cases cover those denials, wrong signing credentials,
missing token, invalid metadata, credential storage failure and configuration
storage failure. The complete Node test suite passes 85 tests.

If request binding is missing or configuration storage is unavailable, errors
still fail closed and remain unsigned; the adapter never invents a configuration
version. This limited fix does not claim all possible unsigned results must
originate outside one-fetch.

## Verification and containment

- [Push CI](https://github.com/OKFred/one-fetch/actions/runs/34754389152),
  [PR CI](https://github.com/OKFred/one-fetch/actions/runs/34754390666),
  [push CodeQL](https://github.com/OKFred/one-fetch/actions/runs/34754389159) and
  [PR CodeQL](https://github.com/OKFred/one-fetch/actions/runs/34754390672) all pass
  for the artifact commit, including Node 24/26 and both hosted-adapter local CI
  stacks. This is not a fresh hosted cloud acceptance claim.
- Review artifact ID `10316833548`: exact inventory of 18 files and all 15
  manifest subjects pass SHA-256/SHA-512 verification, including Node archive and
  multi-platform OCI. Provenance verification is explicitly **not performed**.
- Full local `pnpm check` passes on `bb6f246`; later receipt-label/documentation
  changes separately pass formatting, ESLint and all nine acceptance-tool tests.
  CI now includes all 33 deployment/acceptance safety tests. The modified Gateway
  is 493 lines and the runtime runner is below 500 lines.
- Docker 29.7.2 runs non-root UID 1000, read-only root, bounded resources and
  loopback-only published ports. ARM64 is emulated on an x86_64 Docker host.
- Every acceptance container is removed by verified ownership/full ID and
  independently confirmed absent. No cloud resources were created. Loaded OCI
  images remain only as non-secret local caches.
- The runner creates no host credential files. Instance secrets are passed via
  container environment variables and are visible in Docker metadata to Docker
  administrators until container removal. Bootstrap/database state uses tmpfs;
  admin/session/execution credentials remain in the runner. Earlier receipts'
  `credentialsWrittenToHost` field must not be read as a claim that Docker never
  stored environment metadata.

The earlier restricted Supabase temporary credential/backup/recovery directory
still awaits operator cleanup after execution policy rejected deletion. No
alternate deletion method was attempted; this run does not close that issue.

## Remaining boundaries

This closes the tested Node artifact runtime slice, not three-platform final
release acceptance, provenance, production upgrade/restore, native ARM64 hardware,
CA/mTLS, or independently observed upstream socket cancellation. Hosted Supabase
stream limitations remain as recorded in their own evidence. PR #15 stays draft;
no main merge, tag, Release replacement, public Gateway or xPanel change occurred.

[Machine-readable evidence and original receipt digests](evidence/node-artifact-runtime-2026-09-13.json)
and the [repeatable runner instructions](node-artifact-acceptance.md).
