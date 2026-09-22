# Node interrupted deployment evidence — 2026-09-22

## Exact scope

Implementation and test commit: `bcb43ae4055f8cd79d2a2649768aeb2002e0e57c`.
The worktree was clean for full checks, packaging and both runtime rehearsals.
This is an unreleased 0.1.1 Preview candidate, not a replacement for published
0.1.0, final-commit acceptance or artifact provenance.

Three implementation commits split the helper into small modules, add durable
intent/confirmation records, then exercise forced termination. The released
helper remains one standalone ESM file. Repeated bundling gives identical bytes,
and its CLI successfully plans/installs a synthetic archive outside the checkout.

## Interruption tests

Sixteen real child-process terminations on Windows Node 24.20.0 cover eight
barriers for both the source helper and its standalone bundle:

- Pause intent, before a remote pause request.
- Pause accepted by synthetic Control, but the response lost to the caller.
- Verified SQLite backup.
- Activation intent before replacing the pointer.
- Pointer replaced before the final journal confirmation.
- Restart-required journal written, before releasing the lock.
- Explicit resume accepted but response lost.
- Rollback pointer replaced before confirmation.

Tests check the last durable phase, uncertainty versus acknowledged pause state,
backup SHA-256, selected version and retained owner/PID lock. All three mutating
commands reject retries while that orphan lock exists. Journals contain no
synthetic administrator token, token-file path or Control URL. Three additional
unit cases cover handled failure redaction, unavailable journal storage and
ownership replacement.

The barriers are implemented by the test child intercepting filesystem/Fetch
calls; the production helper has no fault-injection switches. These fixtures
are not tests of killing the real packaged server, OS power loss, directory
fsync guarantees or a full-lifecycle lease. See the
[recovery runbook](deploy-node.md#interrupted-operation-recovery).

## Real archives, separate from interruption fixtures

The published 0.1.0 archive from `21e6b985` and locally built 0.1.1 archive
from `bcb43ae` pass the existing cross-version runner on AMD64 and **emulated
ARM64**. Both use the new standalone helper inside isolated Node 24.20.0
containers. They exercise actual packaged runtime startup, authenticated pause,
backup, activation failure, explicit recovery, update, stale-runtime resume
rejection and code rollback. Each preserves seven original audit events and
verifies nineteen final signatures, with original account/session/policy/token
revocation retained.

This uses the packaged server API, not the CLI/service manager or an application
OCI image entrypoint. It is not the full HTTP conformance suite and performs no
schema-changing or in-place database restoration. Candidate provenance remains
unverified. Earlier baseline attestation evidence and earlier receipts retain
their original identities; they are not relabelled to this commit.

Both newly created owned containers were removed and confirmed absent. Existing
unrelated containers/images were left unchanged. No cloud service, media-center,
xPanel, main branch, tag or public Release was changed.

## Checks and receipts

Full `pnpm check` passed on the exact implementation commit: root tools 159,
Node 98, Cloudflare 58, Supabase tools 66, plus protocol/core/client/admin,
migration/Deno checks, production builds and security gates. Deployment modules
are each below 500 lines. The pre-existing distribution builder remains 513
lines, below the 1,000-line hard limit.

Machine-readable identities and SHA-256:
[evidence JSON](evidence/node-interruption-2026-09-22.json).

Local raw receipts are retained under `.tools/acceptance/`:

- `check-0.1.1-journal-20260922.log`
- `node-upgrade-bcb43ae-amd64.json`
- `node-upgrade-bcb43ae-arm64.json`

CI on the later documentation head and final three-platform release/provenance
gates remain separate. Keep the PR draft.
