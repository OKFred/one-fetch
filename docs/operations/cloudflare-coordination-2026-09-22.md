# Cloudflare deployment coordination acceptance — 2026-09-22

Source: `107871d61140243b6a357104937f6336e01ad075`. This validates the
deployment helper's D1 coordination, not final Release provenance or a new
full HTTP conformance run. Both deployed builds use the same source:
`0.1.1+107871d.install` and `0.1.1+107871d.update`.

## Local checks

- Complete `pnpm check` passed on Node 24.20.0 / pnpm 11.25.0, including
  191 tooling tests. Its log SHA-256 is
  `67a8071a28ac2fc6a867c2f839e7d62dec10f5c8a4888e2bf54303b73e0ac7e7`.
- After the test-canary fix in `e892e92`, complete `pnpm check` passed again
  with 192 tooling tests. The new check log SHA-256 is
  `fc5c6fe214af142c555f089d0f12e3a8f904c14a92e2227de112659d7c379ecf`.
- 42 Cloudflare helper tests cover account/resource binding, stale builds,
  strict storage validation, lost acknowledgements, retained locks, explicit
  recovery, legacy adoption and backup failures.
- Two independent helper processes competed over a shared SQLite database.
  Exactly one acquired ownership. Killing that process retained the lock;
  recovery succeeded only after both processes stopped and exact owner/revision
  were supplied. This is a local process-death test, not a cloud-machine kill.

## Hosted checks

The temporary Workers used the existing pinned compatibility date, no Node
compatibility, and disabled persistent observability. No fixture proxy or
long-term Gateway was created; the system allowlist remained empty.

1. Fresh install initialized shared coordination before application migrations
   and Worker deployment. Health/build/HTTP-only capability verification passed.
2. Four concurrent real D1 conditional updates produced exactly one owner.
3. A wrapper discarded a successful D1 update acknowledgement. The real row
   retained its owner; normal acquisition and recovery with a wrong revision
   failed. Exact owner/revision recovery through the CLI's verify path passed.
4. The guarded update paused traffic, captured old active Worker versions,
   a D1 Time Travel bookmark, a SQL backup and SHA-256, then deployed and verified
   the candidate. A stale original build could no longer acquire ownership.
5. Restoring that SQL export into isolated local SQLite passed `integrity_check`.
   The in-progress lock survived, and a replacement database UUID was rejected.
   No cloud database was restored; this supplements, not replaces, the earlier
   [isolated D1 restoration](cloudflare-candidate-2026-09-22.md).
6. Guarded code rollback restored the recorded active Worker versions and kept
   Gateway paused. A later explicit `verify --resume` passed; Control confirmed
   the resumed flag and the still-empty allowlist.
7. Guarded cleanup deleted the two Workers before D1, verified their absence,
   and a separate account inventory confirmed both DO namespaces absent.

A read-only `whoami` connectivity failure interrupted the first verification
attempt before lock acquisition. Only verification was retried, not install.
There was no automatic retry of an ambiguous mutation.

## Cleanup and evidence

The [redacted receipt](evidence/cloudflare-coordination-2026-09-22.json) records
exact resource IDs, checks and hashes. No credential values, request bodies,
password hashes or SQL backup contents are included.

Two Workers, one D1 database and two DO namespaces were confirmed absent.
Four local files (instance secrets, administrator credentials, access token,
and SQL backup) were deleted after verification. Non-secret journals and
receipts remain. This disposable environment is not recoverable from retained
local credentials or backups. No existing Supabase project was changed.

## Boundaries and remaining gates

- The lock coordinates current helpers; Cloudflare deployment APIs cannot
  consume its revision as a fencing token. Dashboard operations, older helpers
  and privileged SQL remain outside that protection. There is no TTL takeover.
- Legacy adoption is unit-tested, including pause/export/digest ordering and
  refusal to overwrite existing coordination; it was not exercised on a
  separate legacy hosted deployment in this run.
- The older full HTTP/audit receipt remains tied to `b680b1b`; it is not
  relabeled as this run. Final-commit three-platform acceptance and Release
  artifact/provenance verification remain required.
- Push CI initially flagged a synthetic test canary in `fc14994`. `e892e92`
  generates that canary at runtime and exempts only the exact historical
  fingerprint; no path, credential rule or real secret was exempted.
