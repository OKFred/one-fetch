# Node guarded operations and packaged acceptance — 2026-09-13

## Verified result

Exact artifact/runner commit `5f3bcfab21968801e9893d1b142c8447a89ca122` passes
packaged installation, competing-operation rejection, real authenticated
pause/resume and isolated SQLite recovery on AMD64 and emulated ARM64. Both runs
execute all 18 HTTP fixtures. Original audit signatures verify for 40/39 events;
after pause/resume and recovery, 42/41 restored audit signatures verify. Counts
are observations, not exhaustive lifecycle coverage.

The previous `aca73e0` bundle still passes HTTP and its original verification
checks, but fails this expanded gate at `packaged-operation-lock` because it
does not supply the new operation lock. Its failed receipt remains unchanged.
Its later auth/audit summary fields are partial defaults, not a new auth failure.
Historical acceptance is not retroactively relabelled.

## Changes and what the tests establish

`cabf3cb` adds one exclusive operation lock per canonical local installation
root. `apply`, explicit resume and rollback all acquire it before checking the
active version or mutating state. Pointer snapshots and owner identity are
checked again before activation/traffic changes. A replaced lock is not deleted;
an interrupted or malformed lock is never automatically stolen.

Updates now verify the current database and running Control before pausing.
Authenticated configuration must match that identity/revision. Backups must
retain the confirmed paused identity and full migration ledger. New candidates
cannot remove/rewrite applied migrations; rollback checks retained metadata and
SQL before pausing, requires equal schema versions, and retains the reverse
artifact digest. Failures after pause keep the old pointer where possible and
do not automatically resume traffic or restore data.

Twenty new regression cases cover locking, a real two-process first-install
race, killed-owner behavior, stale expected versions/pointers, wrong Control,
config/ledger/backup drift, retained SQL corruption and migration rewrite.
These deployment tests use synthetic archives and a local fixture Control;
they are **not** a real cross-version application upgrade.

`5f3bcfa` extends the downloaded-artifact runner. Inside a fresh container it
uses the actual CI helper to reject apply/resume/rollback while an operation
lock is held, then issues a real Control pause and uses the helper to resume.
It repeats the earlier actual application/session/policy/revocation and backup
recovery checks. No database is restored in place; installation pointers remain
unchanged. A private admin-token file exists only briefly in container tmpfs
for the explicit resume and is removed in `finally`.

## Checks and exact supply-chain input

- Full local `pnpm check` passes on `cabf3cb` and again on `5f3bcfa`: 135 tool
  tests including 39 Node deployment tests. The standalone helper is 823 lines,
  above the preferred 500 but below the hard 1,000 limit; new test/acceptance
  files stay below 500. It remains a single dependency-free deployment artifact.
- Exact [push CI](https://github.com/OKFred/one-fetch/actions/runs/34758815478),
  [PR CI](https://github.com/OKFred/one-fetch/actions/runs/34758817074),
  [push CodeQL](https://github.com/OKFred/one-fetch/actions/runs/34758815456) and
  [PR CodeQL](https://github.com/OKFred/one-fetch/actions/runs/34758817143) pass,
  including Node 24/26 and the Cloudflare/Supabase CI stacks.
- Review artifact ID `10317659018`, 164,381,028 bytes. Exact 18-file inventory,
  all 15 subjects, SHA-256/SHA-512, standalone-helper bytes and OCI index/platform
  identity are verified. Provenance remains unverified; this is not a Release.
- UID 1000, read-only root, bounded resources, disabled Docker logging and
  loopback-only listeners. All three owned containers are removed and confirmed
  absent. Docker administrators can inspect temporary environment credentials;
  container removal is not a secure-erasure guarantee. No host token file,
  public Gateway or cloud resource is created.

## Remaining boundaries

The lock is cooperative, local-disk and operation-scoped. It does not cover old
helpers that ignore it, different roots sharing one database, hostile local
administrators, network filesystems or the interval between activation/restart
and later resume. It is not a distributed/full-lifecycle deployment lease.
See the [orphan-lock recovery procedure](deploy-node.md#interrupted-operation-recovery).
The exclusive-file primitive follows [Node's file-system flags](https://nodejs.org/api/fs.html#file-system-flags).

Actual different-version application upgrade and schema-changing rollback remain
unaccepted. Node's `capabilities.ts` still reports a literal `0.1.0`; runtime
build-version sourcing must be fixed before that rehearsal. No artifact was
relabelled to simulate a second product version. A complete interrupted-update
journal, independent Gateway build handshake, final-commit provenance and the
remaining three-platform release gates also remain separate.

The prior restricted Supabase temporary directory still awaits operator cleanup
after execution policy rejected deletion; no alternative removal was attempted.
media-center was not restored. PR #15 remains draft; no main merge, tag, Release
or xPanel change occurred.

[Machine-readable evidence and original receipt hashes](evidence/node-operation-lock-2026-09-13.json)
and [repeatable artifact runner](node-artifact-acceptance.md).
