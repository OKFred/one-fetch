# Cloudflare 0.1.1 candidate acceptance — 2026-09-22

This is hosted candidate evidence, not a published Release or three-platform
release sign-off. xPanel and both existing Supabase projects were unchanged.
In particular, media-center remained inactive and was not restored.

## Exact inputs and scope

- Source and deployment helper: `b680b1b20ca0d3c42da659e7bd8869f97690dc42`.
- Node 24.20.0, pnpm 11.25.0, Wrangler 4.128.0.
- Compatibility date: 2026-09-04; no Node compatibility; persistent Worker
  observability disabled. Temporary workers.dev endpoints only.
- Initial build: `0.1.1+b680b1b.install`; update: `0.1.1+b680b1b.update`.
  These deploy the **same candidate source with different build identifiers**.
  This verifies the protected deployment workflow, not a published 0.1.0 to
  0.1.1 code/schema compatibility upgrade or final Release provenance.

Two implementation corrections precede this run:

1. `9af295c`: select rollback versions from active deployments, never newest
   uploaded versions; reject split/missing deployments.
2. `b680b1b`: persist pause uncertainty and rollback/backup checkpoints before
   migrations or Worker changes; reject active-version drift and verification
   of failed/incomplete updates. Pause calls reject redirects and time out.

The local Cloudflare deployment tests passed 25/25. Full `pnpm check` passed;
its local log SHA-256 is
`7ebb3cd13531e258ad341a3f93702c3f629ef8d99e09cc67565f810fbf20a833`.
Failure injection is a local test, not a hosted helper-kill exercise.

## Hosted results

- First install and subsequent update both completed, including bootstrap,
  login/refresh/logout/session listing, allowlist and execution token setup.
- Both full HTTP runs passed **17 executed cases with one explicit platform
  skip**, covering arbitrary paths/duplicate query, JSON/form/multipart,
  target 401/429/503 classification, manual redirects, repeated Set-Cookie,
  Server-Timing, streaming, 20 MiB / 20 MiB+1, timeout and cancellation.
- The synthetic truncated-response fixture is skipped because Workers
  normalizes that upstream failure; it is not counted as an executed pass.
- Audit verification checked 36 signed events before update, 38 after update
  and 69 after rollback. All 36 original event records remained byte-identical;
  generated admin password, instance secrets and current access/execution
  tokens were absent from the inspected audit records.
- The update captured a D1 Time Travel bookmark and an 86,465-byte SQL backup.
  Backup SHA-256:
  `2d3a37fbbc81a76e10537077ed44744919ea7863cad63b4c97db225144de81e0`.
- Importing that backup into a separate temporary D1 succeeded. All 14 exported
  tables matched the backup by row count and canonicalized row-content hash.
  The original D1 was never restored in place.
- Explicit code rollback restored both original active Worker version IDs.
  The Control configuration remained paused and a real Gateway request returned
  a signature-verified `forbidden` error with `Gateway is paused`.
  The local probe initially expected a nonexistent `gateway_paused` code; it
  was corrected to the existing protocol contract before the passing probe.

## Cleanup and evidence

All three temporary Workers, both D1 databases (main and isolated restore),
and both created Durable Object namespaces were confirmed absent. No public
Gateway was retained. Exact resource IDs and receipt hashes are in
[the recovery receipt](evidence/cloudflare-recovery-2026-09-22.json).

The two schema-validated HTTP receipts contain no request headers, bodies or
tokens and record cleanup as verified:

- [First install](evidence/cloudflare-install-2026-09-22.json), SHA-256
  `1fe0f87ba353385054c63df494488e439c2ffb6accf3735cd7979b82ed9ef343`.
- [After update](evidence/cloudflare-update-2026-09-22.json), SHA-256
  `d9e403495339f9a701caed4f8e52e5f7cfe792f08c1c5da47f38eea17d2817af`.

The five temporary files (SQL backup, instance secrets, administrator
credentials, access token and execution token) are deleted after receipt
validation. Only non-secret state/configuration and verification
receipts remain locally; this synthetic deployment is not recoverable from
those receipts. Earlier blocked Supabase cleanup files are outside this run.

## Remaining boundaries

- Final Supabase hosted revalidation and final-release Node/Cloudflare artifacts
  still need acceptance. This evidence applies only to the exact source above.
- Cloudflare checkpoints and active-version checks are not a distributed
  deployment lease. Concurrent helper/dashboard deployments are unsupported;
  the broader CAS/lease requirement is not proven by this run.
- Split deployments, real hosted process termination during update, OS power
  loss, schema-changing cross-version recovery and D1 in-place restore are not
  claimed. Code rollback never implies database rollback.
- Keep PR #15 draft. No merge, tag, Release, long-lived proxy or Store change
  was performed as part of this acceptance.
