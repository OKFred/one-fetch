# Node CI candidate and interrupted upgrade — 2026-09-22

## Artifact identity

The downloaded **push CI** review bundle is from
`2329c1f7189816ba46dd90614fedf760e52d78b5`, version 0.1.1, artifact
`10676176058`. This is not a locally rebuilt or relabelled archive.
All 18 files / 15 manifest subjects, SHA-256/SHA-512 lists, standalone helper,
archive identity and OCI index binding pass verification.

The artifact commit's [push CI](https://github.com/OKFred/one-fetch/actions/runs/35683502337),
[PR CI](https://github.com/OKFred/one-fetch/actions/runs/35683504870),
[push CodeQL](https://github.com/OKFred/one-fetch/actions/runs/35683502340)
and [PR CodeQL](https://github.com/OKFred/one-fetch/actions/runs/35683504805)
all passed. The CI matrix includes Node 24.20.0 and Node 26; it also runs the
helper interruption tests on Linux. Later source/evidence commits require
their own checks.

**This review workflow does not attest artifacts.** Final Release provenance
remains unverified and must come from the reviewed-main release workflow.
Internal checksums and a GitHub artifact download are not substituted for that
attestation.

## Eight distinct runtime runs

All runs use actual packaged code on Node 24.20.0. ARM64 is **emulated**, not
native ARM64 hardware. Ordinary runtime runs use clean runner `2329c1f`;
cross-version and interruption runs use clean runner `b1293a5`.

| Run                                       | Platform       | Verified result                                                               |
| ----------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| Direct archive CLI                        | AMD64          | 18/18 HTTP fixtures; auth, revocation and 40 audit signatures                 |
| Original OCI entrypoint                   | AMD64          | 18/18 HTTP fixtures; auth, revocation and 40 audit signatures                 |
| Installed helper + CLI                    | AMD64          | 18/18 HTTP fixtures; 40 original / 42 isolated-restored audit signatures      |
| Installed helper + CLI                    | Emulated ARM64 | 18/18 HTTP fixtures; 39 original / 41 isolated-restored audit signatures      |
| Published 0.1.0 → CI 0.1.1 → 0.1.0        | AMD64          | Activation failure/recovery, guarded update and rollback; 19 audit signatures |
| Published 0.1.0 → CI 0.1.1 → 0.1.0        | Emulated ARM64 | Same checks; 19 audit signatures                                              |
| Interrupted helper update/resume/rollback | AMD64          | Five real SIGKILL checkpoints; 25 audit signatures                            |
| Interrupted helper update/resume/rollback | Emulated ARM64 | Same five checkpoints; 25 audit signatures                                    |

The HTTP fixture suite includes transparent path/query, JSON/form/multipart,
target 401/429/503 versus Relay failures, repeated Set-Cookie, Server-Timing,
streaming, 20 MiB boundaries, timeout, cancellation and partial-download reports.
It does not establish every upstream socket deadline or custom TLS behavior.

Both normal upgrades preserve seven original audit records, original sessions,
policy and revoked-token denial. The new installed runtime is verified before
explicit resume; stale running versions are rejected.

## Real interrupted helper recovery

A separate test child loads the byte-for-byte CI helper and holds five
deterministic checkpoints while the actual packaged server remains alive:

1. Pause accepted, response lost to the helper.
2. SQLite backup verified.
3. Update pointer replaced before its final journal acknowledgment.
4. Resume accepted, response lost to the helper.
5. Rollback pointer replaced before its final journal acknowledgment.

The parent sends SIGKILL and confirms exit. Each case checks actual
Control/Gateway behavior, pointer, journal phase, backup digest when applicable,
and rejected apply/resume/rollback retries. Before recovery, it preserves the
exact orphan lock **only inside the owned disposable fixture**, simulating an
operator after all helper processes have stopped. No production force-unlock
flag, stale-PID takeover, automatic traffic resume or database restoration is
introduced. Original sessions, policy and revocation survive; seven original
audit records remain intact and all 25 final signatures verify.

This kills the **deployment helper**, not the server. Server/SQLite-worker
crashes, OS power loss, schema-changing rollback, full-lifecycle leases and
service-manager restart are not claimed. The upgrade runners use packaged
server exports; separate installed/OCI tests cover normal CLI startup.

## Cleanup and local checks

All eight newly owned container IDs are independently confirmed absent after
their runners' cleanup. Existing unrelated containers and non-secret images
were left unchanged. No cloud resources, media-center restore, xPanel change,
main merge, tag or Release occurred.

HTTP runtime tests use ephemeral keys in Docker environment metadata; Docker
administrators can inspect them until container deletion. Upgrade/interruption
keys are generated inside the container process. Administrator token files
remain mode 0600 in private container tmpfs and are removed. No runner creates
host credential files. Earlier restricted Supabase cleanup remains a separate
operator task; it was not retried by an alternative method.

Full `pnpm check` passed on clean `b1293a5`, including 159 root-tool tests,
workspace tests/builds, generated-file validation and security gates. All new
runner files are below 500 lines.

Exact digests and sanitized per-run receipts are recorded in
[the evidence JSON](evidence/node-ci-candidate-2026-09-22.json). Local raw receipts
remain under `.tools/acceptance/node-ci-2329c1f-*.json`; prior receipts are not
overwritten.

## Remaining publication boundary

The CI candidate now has independent Node distribution, upgrade and
helper-interruption evidence. It does not replace final Cloudflare/Supabase
hosted revalidation, an approved main commit, final Release checksums/provenance
or an explicit disclosure of Supabase provider stream-reset limitations.
Keep the PR draft until those gates are addressed.
