# Supabase protected update, isolated restore and re-update — 2026-09-13

This checkpoint closes the scoped hosted update/functional restore gap for draft
PR #15. It is not complete three-platform Release acceptance. Existing business
databases were untouched; **media-center remained INACTIVE and was not restored**.

## Two defects reproduced and fixed

1. Windows npm command shims truncated the multiline RPC catalog argument to
   `select`. The hosted CLI returned `rows: [{}]`; strict validation correctly
   stopped the update in its backup phase and left Gateway paused, without
   replacing either Function. Passing the exact query through `--file` returned
   all **39** owned RPCs with their original owners and service-only grants.
   Commit `c355500534e16488452dd383ad35722e29c9c728` uses an exclusive private query
   file and removes it on success/failure. It does not relax catalog/ACL checks.
2. The official Function download/recovery flow places the compiled bundle at
   `functions/<slug>/index.js`. Restoration worked, but the next protected-update
   inventory check rejected that path. Commit
   `3bf479a02b10d76be12390a11a45251e9d856c67` accepts precisely this restored layout
   and the normal `.one-fetch-bundle/index.js` layout. Source TypeScript, unrelated
   filenames, nested/traversal paths, wrong slugs and query suffixes stay rejected.
   Build/pair, status, JWT setting, version and digest checks remain in force.

The first three baseline attempts also exposed a local CLI location problem:
the detached worktree's executable could not reach the Management API, while
the primary checkout's byte-identical CLI could. Baseline installation used the
official `SUPABASE_CLI_BINARY_OVERRIDE` with the verified, identically hashed
**2.116.0** executable. No firewall/TLS setting, deployment gate or baseline code
was changed. The later current-checkout deployments needed no override.

## Real hosted sequence

| Stage                | Runtime build suffix | Disposable project     | Result                                                                            |
| -------------------- | -------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| Fresh installation   | `ga8823b27575e`      | `ygnznpkwmogbnhxfzbqk` | Empty baseline, ten migrations, paired Functions and bootstrap passed             |
| Protected update     | `gc355500534e1`      | Same source project    | v2 backup, lease, Function replacement and exact handshake passed                 |
| Isolated restoration | `ga8823b27575e`      | `rrvwpvmwuzqqikzsyxtb` | Schema → RPC → data, original instance secrets and captured old bundles passed    |
| Protected re-update  | `g3bf479a02b10`      | Same restored project  | Restored entrypoints accepted; backup, lease, normal bundles and handshake passed |

Every build above uses the `0.1.0+supabase.` prefix. The old source commit is
`a8823b27575efe13ad62da3661926cad59962c00`; the two fixes are listed above.
Test-only commit `1f19d1a` moves metadata tests into their own small file without
changing the tested implementation.

The source project was deleted only after updated-instance conformance and
backup integrity passed. Its restricted local backup survived that deletion and
was restored into a newly created project; this was not a reset or overwrite of
the source, media-center, or another existing database.

Verified across that sequence:

- A wrong expected build is rejected. A second deployment lease is rejected
  while the first is held; the synthetic probe lease is then released without
  advancing the current build. This is a hosted competing-lease check, not a
  load/stress claim.
- Both successful updates default to paused Gateway. Paused requests return a
  signed Relay denial; the acceptance client explicitly resumes afterward.
- The three-part source backup contains **39 RPCs**, **16 application tables**
  and **10 application/provider migration records in each ledger**. Restoration
  preserves the previous build and clears no data by rewriting migrations.
- The original username/password can log in after restoration and re-update.
  The original execution Token works; its later revocation persists and produces
  a signed `unauthorized` response immediately afterward.
- Policy content and prior audit event IDs survive. **158** final audit events
  pass verification with the original Ed25519 public key. Known synthetic
  credentials and request-secret canaries are absent from audit responses.
- Target 200/404/503 remain signed target results, distinct from Relay denials.
  Original duplicate-slash path/query bindings remain intact.

## HTTP and local gates

The same shared `--watch-reports --full` suite ran on the updated source, the
restored old runtime, and the re-updated runtime: **17 executed passes + 1
explicit skip per run**. It covers request/body formats, binary data, redirects,
target status classification, Set-Cookie metadata, Server-Timing, 20 MiB limits,
timeout and cancellation. These are synthetic target requests only.

The skip is the injected truncated-response fixture: Cloudflare normalizes that
synthetic errored stream before Gateway receives it. Neither this skip nor the
opt-in report watcher proves an upstream socket disconnect or repairs the
previously documented Supabase stream-reset behavior.

Node **24.20.0** full `pnpm check` passed on both implementation commits. The
final implementation has **54** passing deployment-script tests. Test separation
was rerun with the same 54 passes, keeping changed source/test files below the
preferred 500 lines. No dependency, protocol, lockfile, migration or runtime
handler change was needed.

The query-file change also passed a fresh isolated local PostgreSQL **17.6**
restore: 39 RPCs, 16 tables with identical rows, ten provider migration rows,
stored account/session behavior and **7 SQL suites / 144 assertions**. Its exact
network-disabled Docker container was removed. The hosted restore used the
digest-pinned PostgreSQL client image recorded in the evidence; it is a separate
result from that local database test.

## CI and artifact identity

Exact `3bf479a02b10d76be12390a11a45251e9d856c67` passed
[push CI](https://github.com/OKFred/one-fetch/actions/runs/34751186484),
[PR CI](https://github.com/OKFred/one-fetch/actions/runs/34751190520),
[push CodeQL](https://github.com/OKFred/one-fetch/actions/runs/34751186501) and
[PR CodeQL](https://github.com/OKFred/one-fetch/actions/runs/34751190575).

Downloaded push review artifact `10315569608` matches that exact branch commit:
**18 files / 15 subjects**, complete inventory, SHA-256 and SHA-512 verified.
Manifest SHA-256:
`00c43edd27bbd069c1a456cc374001e24d57811b51990161ca9c781412158943`.
It is a CI review bundle, not a published Release, verified attestation or an
additional OCI runtime drill. Test/documentation-only follow-ups have their own
CI status; these results are not silently relabelled to another commit.

## Evidence and cleanup

[Sanitized evidence and receipt hashes](evidence/supabase-update-restore-2026-09-13.json)
contain build identities, part digests, checks and exact cleanup boundaries, not
Tokens, SQL bodies, request bodies or Header values. Original local receipt:
`.tools/acceptance/supabase-final-evidence-6ff15bec71e4.json`; SHA-256
`43a80ca75d1bb8f71d2cedb7c77aabf5d22fa5d28cd7ea95070b1bc489cb13ea`.
Failed probes are retained separately rather than overwritten with passes.

- Both exact disposable Supabase projects and Cloudflare Worker
  `one-fetch-fixture-6ff15bec71e4` were deleted and independently confirmed absent.
  There is no Gateway left running from this acceptance.
- Worker observability, Logpush and Tail Consumers were disabled. Only synthetic
  data was used. Existing business projects were unchanged.
- Known-secret canaries passed across 50 local output/helper files before private
  material was deleted. Temporary application credentials, SQL backups and
  captured recovery sources were then destroyed; user CLI credentials remain.
- The detached baseline worktree is deregistered. Git deletion failed on Windows
  long paths and follow-up removal was policy-blocked, so a **non-sensitive local
  directory remains** at `.tools/worktrees/supabase-update-source-a8823/`.
  Cloud/credential cleanup is complete; full local-directory cleanup is not.

## Remaining release boundary

Keep PR #15 draft. The separate dumps are not one atomic database snapshot:
writer quiescence was controlled in these private synthetic instances, with no
other client or scheduled writer. Production encryption and operator-controlled
quiescence remain required. A checksum-only verifier still reports
`restoreVerified: false`; this behavioral receipt is separate evidence.

Hosted mid-deployment failure/automatic Function rollback, independent upstream
disconnect observation, provider stream behavior and the remaining cross-platform
release/recovery gates are still open. No merge, tag, Release, published artifact
replacement or xPanel change occurred.
