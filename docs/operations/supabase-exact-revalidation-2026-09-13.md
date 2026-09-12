# Supabase exact-query Gateway revalidation — 2026-09-13

This run tested commit `8fc5fa2920e2998e732c83e76f8ae19fdf4eaedc`, build
`0.1.0+supabase.g8fc5fa2920e2`, on a new disposable Supabase project. Dates in
the title use Asia/Shanghai; timestamps below use UTC. This is a real paired
Control/Gateway and client test, not just the earlier ingress-only diagnostic.

**The tested exact-path/query regression is resolved:** the expanded shared
suite has **17 executed passes and one explicit skip**, and the additional
boundary runner has **30 passes**. This does not establish arbitrary URL
support, prompt oversized-stream termination, upstream cancellation latency,
protected-update/restore acceptance, or a new three-platform Release.

## Authorization and isolation

The operator explicitly authorized continued verification and instructed that
`media-center` must **not be restored** afterward. It was paused, then confirmed
`INACTIVE`. The separate random project was created only after the pause. No
existing application database, schema, Function or application secret was
changed. Another existing project remained `ACTIVE_HEALTHY`.

The temporary Cloudflare Worker only served synthetic conformance fixtures.
Provider settings independently confirmed persistent observability disabled,
Logpush disabled, no Tail Consumers, compatibility date `2026-09-04`, and no
Node compatibility. This follows the Cloudflare/Workers/Wrangler guidance while
retaining the project's explicit pinned configuration; it does not assert that
all provider-internal logging is absent.

## Installation and build identity

The read-only preflight passed with no existing one-fetch Functions. The
first-install apply verified the empty owned-schema catalog, saved its hashed
empty baseline, applied ten migrations, completed the deployment CAS lease,
deployed both Functions, and verified their paired instance and exact build at
`2026-09-12T19:50:26.528Z`.

Node `24.20.0`, Supabase CLI `2.116.0`, Deno `2.9.6`, and Wrangler `4.128.0`
were used without dependency upgrades. Deployment preflight reran 36 Control,
67 Gateway and 38 deployment-script tests, type checks, migration/OpenAPI checks
and self-contained bundle generation. Bootstrap, session listing, refresh,
logout/login, exact fixture allowlisting and execution-token creation passed.

The empty baseline is evidence of a first install, **not** a recovered database
backup: the journal correctly retains `restoreVerified=false`. No restoration
exercise was performed in this run.

## Shared HTTP suite

The report was generated at `2026-09-12T19:52:17.566Z`:

- Arbitrary `/v1` path, repeated query fields, JSON, urlencoded, multipart,
  binary request data and multi-chunk response cases passed their existing
  assertions. No target expectation was weakened.
- `//v1/echo` still returned signed **target 404**, preserving its original path
  and percent spelling. The new query-space fixture returned signed target 200
  with literal `%20`, `+`, `%2b`, `%2B` and duplicate-field order intact.
- Target 401, 429 and 503 remained target responses. Manual redirect,
  per-item Set-Cookie metadata without Gateway cookies, and target Server-Timing
  passed.
- Exactly 20 MiB completed in about **5.18 seconds**. At 20 MiB + 1, the client
  timed out after **60.70 seconds**, while its finalized report was `partial`
  with `bodyComplete=false`. The result passes the suite's incomplete-outcome
  assertion, **not** an immediate rejection or prompt connection-close gate.
- Short timeout and cancellation produced client `TimeoutError` and
  `AbortError` in about 106 ms and 35 ms. These observations do not prove when
  an upstream connection was established or disconnected.
- `truncated-response` was explicitly skipped because the Cloudflare synthetic
  target normalizes an injected stream error. A skipped case is not an
  executed pass.

## Additional boundary suite: 30 passes

Twenty synthetic paths cover all 16 independently recorded ingress cases and
four additional slash/query boundaries. Every result had a valid target
classification, agreed with the direct fixture, and matched the original
Fetch-serialized path and query exactly. Coverage includes space/plus spelling,
encoded separators, Unicode percent bytes, unreserved escapes, punctuation,
query keys, repeated and bare fields, double encoding and leading/middle slashes.

Six missing, malformed or conflicting bindings returned signed
`unsupported_option` or `invalid_metadata`. User and system deny rules matched
the original path; target redirects used their new path rather than reapplying
the initial binding.

The thirtieth case placed a synthetic secret in query, Authorization, Cookie
and body. Neither that canary nor the access/execution tokens appeared in the
retrieved audit page and finalized report; adapter metadata was absent, the
redaction marker was present and the original path was retained. These checks
cover returned application records, not every database byte or provider log.

The shared suite and boundary runner overlapped. Only the exact synthetic
`//protected` path was temporarily denied during the system-policy check; the
original policy was restored before resource cleanup.

## Evidence and cleanup

Local redacted receipts are ignored by Git. SHA-256 values bind their contents:

- `.tools/acceptance/supabase-exact-verified-459756c84fe1.json`:
  `18bdf60d1c61d49314d305a1839d326475e98c3f2fbbd8b492a2681e623405df`.
- `.tools/acceptance/supabase-exact-boundaries-459756c84fe1.json`:
  `956f09310bcff3347f53bdaac0d845a26c949ed3667bb1b15d0594e263c88c9c`.
- `.tools/acceptance/supabase-exact-audit-459756c84fe1.json`:
  `fa68cac0c0e9b35c6aba6d662c4deb018246dff4e1eb1683dd650891f546e299`.
- `.tools/acceptance/supabase-exact-apply-459756c84fe1.json`:
  `8967bc89dc0e92fcd707d39832b47e021b63b58f8aeccac1d92988685191c2ac`.
- `.tools/acceptance/supabase-exact-platform-459756c84fe1.json`:
  `68a095c86b0332ff6b30c26259b44dc6c624b75cde151a9e432b28e6285b5c7d`.

The temporary Supabase project `jbzgzyemkcffxrqowrvl` was deleted; independent
inventory confirmed it absent at `2026-09-12T19:52:59.016Z`. The exact fixture
Worker `one-fetch-fixture-459756c84fe1` was deleted and independently confirmed
absent at `2026-09-12T19:52:53.633Z`. Only then was the report finalized with
`cleanup=verified`. No public Gateway was retained.

All six temporary application credential files and their private directory were
removed after secret-canary checks across the run's receipts. Existing user CLI
credentials were not removed. **media-center remains paused (`INACTIVE`) as
requested; no restore was attempted.** Project status is not application/data
acceptance.

## Decision boundary

This closes the exact hosted path/query rerun requested for the tested build.
The [older failed Gateway run](supabase-revalidation-2026-09-13.md) and
[ingress-only diagnostic](supabase-ingress-diagnostic-2026-09-13.md) remain
separate historical evidence. Unknown ingress rewrites still fail closed.

Keep the independent oversized-stream/cancellation limitations and update/
restore release gates open. This verification does not merge the PR, create a
Release, replace published `v0.1.0` artifacts or modify xPanel.

## Subsequent local stream regression

A separate [local cancellation regression](supabase-stream-cancellation-2026-09-13.md)
reproduced delayed downstream errors when upstream cleanup remains pending,
and fixed the response monitor's abort/terminal ordering. That code has not been
revalidated in a hosted environment; this run's commit, 60.70-second observation
and acceptance boundaries remain unchanged.
