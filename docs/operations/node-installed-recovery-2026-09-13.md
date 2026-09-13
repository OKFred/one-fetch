# Node CI first-install and isolated recovery — 2026-09-13

## Result and tested identities

The complete push-CI bundle for
`aca73e082ef3b48e5574fdfa82cf9e147d67f6db` passes first-install and isolated SQLite
recovery with the clean runner `c8739fe9fd4dcd6fc23ca1cd8acb65f6e34786a4`.
The tested standalone helper is the checksum-verified CI artifact, not a
substituted checkout file. Product version remains `0.1.0`; this is not a new or
replacement Release.

| Run                                     | Runtime                                | HTTP cases | Original audit signatures | Restored audit signatures |
| --------------------------------------- | -------------------------------------- | ---------- | ------------------------- | ------------------------- |
| Installed archive and isolated recovery | Node 24.20.0, AMD64                    | 18/18      | 40                        | 40                        |
| Installed archive and isolated recovery | Node 24.20.0, ARM64 emulated on x86_64 | 18/18      | 39                        | 39                        |
| OCI default entrypoint                  | Node 24.20.0, AMD64                    | 18/18      | 40                        | Not a restore run         |
| Direct portable archive                 | Node 24.20.0, AMD64                    | 18/18      | 40                        | Not a restore run         |

Both installed runs execute the packaged helper's `apply --expected-version
none` and `launch`. They then perform a real online SQLite backup, record its
SHA-256, copy it to an isolated database and start another runtime from the
installed application. Seven migration entries and their SQL/checksum integrity
match. Original sessions and configuration survive; the previously revoked
execution token still receives a signed `unauthorized` denial. Every returned
restored audit event verifies with the original instance key. Event counts are
observations, not proof of every audit lifecycle path.

No database is restored in place. The original installation pointer remains
unchanged. All database copies, instance keys and bootstrap state are temporary;
all owned acceptance containers are independently confirmed absent.

## Verification defect and failed baseline

Before `74fbf55`, deployment verification accepted a missing database, checked
only the maximum migration number, and compared a Control's version without its
instance identity. Offline verification also returned `verified`, incorrectly
implying that a running service had been checked.

The fix requires an existing regular SQLite file, integrity check, complete
contiguous ledger, and matching packaged migration bytes/digests. Online checks
also require matching protocol, provider, build version, instance ID,
Control/Gateway pair and configuration version. Invalid storage/identity is
rejected before any resume request. Offline success is explicitly
`offline-verified` with `runtimeVerified: false`. Seventeen new regression cases
cover these boundaries, including malformed identity JSON without secret echo.

The actual older `b518bb1` CI archive passes 18 HTTP cases but fails the new
offline-verification assertion. This is an intentionally retained negative
baseline, not a successful deployment or restore. Its later auth/audit summary
fields are partial defaults because the installed check failed before the full
acceptance return.

Two earlier attempts timed out during Docker container creation with file bind
mounts. A no-mount control created immediately; an existing fixture bind also
timed out. These are environment-stage failures, not application failures. The
runner now streams a fixed set of non-sensitive files through Docker stdin into
private tmpfs and checks the received bytes/digests before activation. No Docker
restart, broad cleanup, host permission change or root staging process was used.
Failed receipts are preserved unchanged in the machine-readable evidence.

## CI, artifacts and containment

- Artifact commit: [push CI](https://github.com/OKFred/one-fetch/actions/runs/34757341875),
  [PR CI](https://github.com/OKFred/one-fetch/actions/runs/34757343348),
  [push CodeQL](https://github.com/OKFred/one-fetch/actions/runs/34757341808) and
  [PR CodeQL](https://github.com/OKFred/one-fetch/actions/runs/34757343341) all pass.
- Review artifact `10317064965`, 164,378,827 bytes: exact inventory of 18 files,
  all 15 manifest subjects, SHA-256 and SHA-512 verified before execution.
  OCI platform/revision labels and non-root identity are checked separately.
  GitHub provenance is **not verified**, and no Release asset is replaced.
- Full local `pnpm check` passes for implementation `c8739fe`, including 85 Node
  tests and 115 tool tests. Its [push CI](https://github.com/OKFred/one-fetch/actions/runs/34757685395),
  [PR CI](https://github.com/OKFred/one-fetch/actions/runs/34757687597),
  [push CodeQL](https://github.com/OKFred/one-fetch/actions/runs/34757685404) and
  [PR CodeQL](https://github.com/OKFred/one-fetch/actions/runs/34757687609) all pass.
  Runtime evidence remains bound to the downloaded `aca73e0` bundle, not this
  runner's newly generated artifacts. The standalone deployment helper
  is 636 lines, above the preferred 500 but below the hard 1,000-line limit;
  all new acceptance implementation files are below 500 lines.
- Docker 29.7.2, UID 1000, read-only root, disabled container logging, private
  tmpfs, bounded memory/PIDs and loopback-only published listeners. No cloud
  resource was created. Loaded images remain non-secret caches.
- No runner-created host credential files. Docker administrators can inspect
  environment-based instance keys and temporary process credentials. Cleanup is
  confirmed container removal, not a promise of secure erasure of Docker's disk.
- The previously restricted Supabase credential/backup/recovery directory still
  exists and awaits operator cleanup after execution policy rejected deletion.
  It was not deleted by another method. No media-center restore was attempted.

## Still separate acceptance requirements

This closes first installation and an isolated recovery rehearsal, not a
different-version production upgrade, deployment CAS/lease concurrency, rollback
across schema versions, or proof of a running process's physical database path.
Copying a database preserves its logical identity. Node update/rollback guards
still need their own strengthening and real acceptance; passing `verify` alone
does not certify the complete update workflow.

Three-platform final-commit acceptance, provenance, provider stream limitations,
native ARM64 hardware, independently observed upstream disconnect timing and the
earlier pending cleanup remain open. PR #15 stays draft. No main merge, tag,
Release, long-lived public Gateway or xPanel change occurred.

[Receipt digests and machine-readable evidence](evidence/node-installed-recovery-2026-09-13.json)
and [repeatable acceptance commands](node-artifact-acceptance.md).
