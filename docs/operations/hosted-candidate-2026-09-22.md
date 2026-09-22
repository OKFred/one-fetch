# Hosted 0.1.1 candidate checkpoint — 2026-09-22

Source: `d9324a17e954fcb7f3bd6438d318e5f8879e2844`. This is a candidate
checkpoint, not a final-release or cleanup receipt. All four push/PR CI and
CodeQL workflows passed for this source.

## Cloudflare legacy-helper adoption

A random disposable deployment was installed using the pre-coordination
entrypoint from `dcd1df1`, with current shared helpers and runtime source.
Before adoption, its local state had no pinned account and the remote D1
coordination table was absent. No existing table was deleted to simulate age.

The current helper paused Gateway, exported D1, recorded the backup digest,
created coordination, pinned account/resource identity and released ownership.
Explicit verification/resume passed. Full HTTP conformance then passed all
17 executed cases, including the 20 MiB boundary, with one declared synthetic
stream-error skip. The backup SHA-256 is
`e0a1199eb0a4d38b044f27b2effd1f6e738f482bf65e3843602bc2843638d120`.
This validates legacy deployment-state adoption, not a published 0.1.0 runtime.

## Supabase fresh install and restore regression

A newly created Free project passed empty-schema/function validation and the
actual installation workflow. Its build is `0.1.1+supabase.gd9324a17e954`.
The existing media-center project remained inactive and unchanged.

- Bootstrap, existing account login, execution credentials and signed target
  200/404/503 results passed. Original double-slash paths and credentials were
  forwarded to a synthetic target.
- Stale expected versions and concurrent deployment leases were rejected;
  the probe lease was explicitly released.
- All 59 baseline audit events verified with the instance public key. Secret
  canaries were absent; only identifiers and hashes were retained in evidence.
- Full HTTP conformance passed 17 executed cases, with the same explicit
  Cloudflare synthetic-target stream-error skip. Terminal-report watching
  detected the oversized response; it does not prove upstream disconnection.
- A separate real local PostgreSQL restore regression passed 144 assertions:
  three backup parts, 16 tables, 39 public RPC functions and 10 migrations.
  Its owned test container was removed. This is not yet a restoration of the
  newly created hosted project's backup into another hosted project.

## Retry disclosure and remaining work

Initial HTTP attempts recorded client-side `fetch failed` errors: all cases
on the first Cloudflare attempt, and the 20 MiB case on Supabase. Subsequent
serial full runs passed without code or fixture changes. Failed receipts are
retained; the underlying transient connection cause is not established.

Protected updates, isolated hosted restoration, cloud cleanup and final-main
artifact/provenance checks still follow. Temporary resources currently remain
only for that acceptance; this checkpoint does not claim their deletion.

## Local receipt digests

The run suffix is `f47fa8a8a027`; reports contain no tokens, Header values or
body contents. These SHA-256 values identify the unmodified local receipts:

| Receipt                            | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| Cloudflare adopted full HTTP retry | `4f8e6e09991bd76d6192fd093804c969755e919b2e8edaf4646f255e382eba4c` |
| Supabase installed full HTTP retry | `cf39737bcf43ff094f9fa1ab642badb9750a1553f9c9cadf7c248004287a5be7` |
| Supabase baseline audit/CAS        | `f50d90bc83d508ff69556d674278ae030c3216309a8479a3cd5b972e0aebacbc` |
| Local PostgreSQL restore           | `c5c89133d49c38abbe8c1223ece972c91e22f0427e67590bcec8a54d3d87641f` |
