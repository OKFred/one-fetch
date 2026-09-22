# Hosted Supabase code rollback acceptance — 2026-09-13

## Scope and identity

The guarded updater at `ad449d6ec0124cd8257d371eaf0b0f0a003099db` passed
two real hosted Function rollback scenarios and a subsequent normal update.
This is **client-side fault injection after confirmed provider writes**, not a
claim that a Supabase outage, database rollback or incompatible migration was
reproduced. Keep PR #15 draft for the remaining release gates and local cleanup.

- Baseline: `d82e1ea83f32dbad7d3e609b889ad90122f8ee85`, runtime
  `0.1.0+supabase.gd82e1ea83f32`.
- Updated runtime: `0.1.0+supabase.gad449d6ec012`.
- Disposable project: `one-fetch-update-4d309b22c842`,
  `xklrpxnraudpcuoiunwa`.
- Only synthetic accounts and credentials were used. The system allowlist
  remained empty; Gateway was paused before fault testing and never resumed.
  No upstream target or Cloudflare fixture was needed.

The [sanitized machine-readable receipt](evidence/supabase-hosted-rollback-2026-09-13.json)
contains eight acceptance-receipt SHA-256 values, four deployment-state hashes,
exact build IDs, backup digests, checks and cleanup status. It contains no tokens,
passwords, request headers or body values. Follow-up documentation commits do not
change or relabel the tested runtime.

## Verified sequence

1. Install the clean baseline using the normal guarded first-install CLI.
   Bootstrap, refresh, logout and original-account login passed. Create one
   short-lived HTTP execution credential; verify a signed paused denial.
2. Start the protected update with the exact expected baseline. The acceptance
   command wrapper lets the real Control deployment succeed, then independently
   observes new Control / old Gateway versions, the paused empty policy, and a
   competing CAS lease being rejected. Only then does it throw a synthetic client
   error. This exercises the ambiguous **first command** failure case, where the
   provider changed state but no successful command was recorded by the updater.
3. The normal failure handler checks captured recovery bytes, renews its lease,
   redeploys both old compiled bundles and verifies the old runtime/pause. A
   separate paired handshake and read-only SQL query confirm the old build,
   `pending_build = null` and `lease_id = null`. The v2 backup still passes its
   read-only integrity check. Original account, credential, policy and prior
   audit records remain valid.
4. Repeat with the fault injected **after both new Functions are confirmed
   serving**, but before the updater can finish. The same rollback, lease,
   backup and account checks pass.
5. Run the unmodified guarded CLI again with the actual old build. The normal
   update succeeds, both Functions advertise the new build and Gateway remains
   paused. Original credentials and policy remain usable; all **18** final audit
   events verify with the original Ed25519 public key, prior IDs are retained,
   and known secret/body/auth canaries are absent from audit responses.

There is no production fault-injection flag. The isolated acceptance wrapper
uses the existing `runDeployment({ command, applyDeployment })` test seams and
refuses a different project identity, baseline or implementation commit. It does
not bypass preflight, backup, migration, secret, lease or runtime checks. Its
checkpoint probes are read-only except for a deliberately rejected competing
lease request. Only the two owned Function deploy outcomes are faulted.

## Implemented protections and checks

- Attempt journaling precedes the CLI call, so a remote write followed by a
  command error is eligible for recovery.
- Recovery validates a filename/length-framed SHA-256 tree before execution and
  rejects changed bytes or symbolic links. It keeps and renews the CAS lease
  during code recovery; lease loss prevents further recovery writes.
- A successful CLI exit cannot alone mark rollback successful: the old paired
  runtime and pause must also be confirmed. Partial first-install deletion must
  instead be confirmed by an empty owned-Function inventory.
- Lease release happens after recovery settles; an unconfirmed release is
  recorded explicitly, not swallowed as success.
- **66 deployment-script tests** pass, including first-command ambiguity, stale
  runtime, unhealthy pair, lost lease, changed recovery bytes, digest framing,
  pause failure and a Function remaining after a nominally successful delete.
- Full local `pnpm check` and exact implementation
  [push CI](https://github.com/OKFred/one-fetch/actions/runs/34752734222),
  [PR CI](https://github.com/OKFred/one-fetch/actions/runs/34752735288),
  [push CodeQL](https://github.com/OKFred/one-fetch/actions/runs/34752734206) and
  [PR CodeQL](https://github.com/OKFred/one-fetch/actions/runs/34752735286) pass.
  The four changed implementation/test files contain 367, 136, 379 and 186 lines.

## Cleanup and limits

The exact disposable project was deleted and independently confirmed absent.
No public Gateway remains from this run. Existing business resources were not
restored or changed: media-center remained **INACTIVE**, and the other existing
project remained **ACTIVE_HEALTHY**.

Local deletion was rejected by execution policy before it ran. **37 temporary
credential, backup and recovery files remain in the run's access-restricted
directory and require operator cleanup.** No alternate deletion mechanism was
used to bypass the refusal. Global CLI credentials and the previous run's
non-sensitive long-path residue were not touched. The receipt deliberately does
not claim complete local cleanup. Known current credential canaries were absent
from 22 local acceptance helper/receipt/log files before cleanup was attempted.

No database restore or schema change was exercised here. Automatic rollback does
not restore provider secrets or reverse forward migrations; this run preserved
the instance keys and used the unchanged schema. Previous isolated restoration
has [separate evidence](supabase-hosted-update-restore-2026-09-13.md). Provider
stream-reset behavior, independently observed upstream disconnect, remaining
three-platform release acceptance and published-artifact provenance are not
closed by this code rollback test. No merge, tag, Release, published artifact
replacement or xPanel change was performed.
