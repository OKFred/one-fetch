# Node 0.1.0 → 0.1.1 candidate acceptance — 2026-09-22

## Verified result

The published `v0.1.0` Node archive upgrades to a real, locally packaged 0.1.1
candidate and rolls back on AMD64 and **emulated ARM64**, without restoring a
database in place. The clean runner is `5efb41f7bddd4ac752f97fb55c7af65e310c1ab2`;
the candidate archive is from `67f078dd1e645c5b0db32acb7e0a6e259b9367b9`.
These are different identities and are not relabelled as a final CI artifact.

Both runs verify:

- Real published-archive installation, bootstrap, original account/session,
  policy and execution-token revocation surviving upgrade and code rollback.
- Health, capabilities and OpenAPI returning the actual 0.1.0/0.1.1 version.
- POST body and arbitrary repeated query keys, signed target response,
  separate Set-Cookie entries and Server-Timing.
- Wrong expected version/bad digest rejected before pause; a real post-pause
  rename-permission failure retaining the old pointer and paused Gateway.
- Explicit recovery from that failure, successful update, SQLite backup digest,
  stale-running-version resume rejection and verified explicit resume.
- All **7 original audit events preserved**, and **19 final audit signatures**
  verified per run. Counts are observations, not exhaustive audit coverage.

All runner-owned containers are removed and independently confirmed absent.
No host listener, host credential file, public Gateway, cloud deployment,
media-center restore, main merge, Release or xPanel change was performed.

## Exact inputs and checks

- Old archive source: published commit
  `21e6b985f32e0dcfab5389dd7b2a77b89f72377b`; SHA-256
  `ddb122ada1614b8585958473383a6a4ac64ceb9e40ab13a2ebb8efe535c8bb5c`.
  Rechecked against GitHub's current release asset digest.
- Old archive attestation **verified separately** using `gh attestation verify`,
  exact repository, `release-review.yml` signer workflow, exact source digest
  and rejection of self-hosted runners. This claim covers that archive only.
- New local archive SHA-256:
  `6a7f2d5fe09da9af2e4098e7169c4e09075697cf6f94c4e5678afb2356fadf4a`.
  Candidate helper SHA-256:
  `39061967bf75eb4e94f2e1c0c29d88b69bbdcf1189f410daec0a3a07d5954974`.
  Candidate provenance remains unverified.
- Full local `pnpm check` passes on clean `5efb41f`: 98 Node adapter tests,
  58 Cloudflare tests, 66 Supabase tool tests and 139 root tool tests, plus the
  remaining workspace suites, type checks, builds and security gates.
- Both CodeQL runs for `5efb41f` pass:
  [push](https://github.com/OKFred/one-fetch/actions/runs/35640335739),
  [PR](https://github.com/OKFred/one-fetch/actions/runs/35640343454).
  At evidence capture, [push CI](https://github.com/OKFred/one-fetch/actions/runs/35640335942)
  and [PR CI](https://github.com/OKFred/one-fetch/actions/runs/35640343372) are
  still running, not claimed complete.
- All new upgrade-runner implementation files are below 500 lines (largest:
  284). Existing helper/build-tool size exceptions remain below 1,000.

The initial runner used the wrong response-header property and failed before
baseline completion; its failed receipt is preserved. A corrected exploratory
dirty-runner pass is also preserved but is not the clean acceptance evidence.

## Remaining boundaries

This rehearsal uses packaged server startup functions, not CLI/service-manager
restart. It does not simulate process death, power loss, schema-changing
rollback, full-lifecycle deployment fencing or an independent Gateway build
handshake. Complete interrupted-update journaling remains open. The new
candidate still needs final-commit three-platform/CI-artifact acceptance and
provenance verification. Prior Supabase stream-reset limitations and earlier
operator-only local cleanup remain open; no prohibited cleanup retry occurred.

[Repeatable procedure](node-cross-version-acceptance.md) ·
[Machine-readable evidence](evidence/node-cross-version-2026-09-22.json).
