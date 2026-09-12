# Supabase hosted path-binding revalidation — 2026-09-13

This run tested commit `780da067a3580923c6a4eeec069f6c2b3808ff7b`
(`0.1.0+supabase.g780da067a358`) on a new disposable Supabase project. The date
uses Asia/Shanghai; machine evidence records UTC on 2026-09-12.

The previously failing double-slash case now passes. **This is not unrestricted
path/query fidelity acceptance:** an additional encoded-space probe failed
closed. No published `v0.1.0` artifact or tag was replaced, and xPanel was not
changed. The [previous failed run](supabase-revalidation-2026-09-12.md) remains
immutable evidence for its earlier commit.

## Installation and shared HTTP suite

The real first installation verified the empty schema catalog, recorded its
hashed empty baseline, applied ten migrations, completed the deployment CAS
lease, deployed both Functions, and verified their pair/build. Bootstrap,
sessions, refresh, logout/login, exact fixture allowlisting, execution-token
creation and the initial audit secret-canary check passed.

The existing shared suite executed **16 passing cases and one explicit skip**:

- Leading `//v1/echo` reached the target literally and returned signed target
  **404**, retaining `tag=one&tag=two&escaped=%2f`. The old expected result was
  not changed.
- Arbitrary `/v1` paths, duplicate query parameters, JSON, form and multipart
  bodies, target 401/429/503 classification, manual redirect, separate
  Set-Cookie metadata, Server-Timing and streamed bodies passed.
- The 20 MiB response completed. For 20 MiB + 1, the client still observed
  `TimeoutError` after about **60.75 seconds**; the terminal report was
  `partial` with `bodyComplete=false`. This meets the suite's incomplete-result
  criterion, not a prompt stream-termination guarantee.
- Timeout and cancellation observed client TimeoutError/AbortError only. They
  do not prove that the upstream connection was established or its disconnect
  latency.
- `truncated-response` remains explicitly skipped: the Cloudflare synthetic
  target normalizes its injected errored stream. It is not an executed pass.

## Additional boundary probes: 14 pass, 1 fail

Direct fixture comparisons confirmed literal repeated slashes in different
path positions, duplicate queries, lowercase/mixed-case percent escapes and
double-encoded values. Six missing/malformed/conflicting original-path
bindings returned signed `unsupported_option` or `invalid_metadata` rather
than target responses. System and user deny rules matched the original path;
a redirect used its new target path rather than reapplying the initial binding.

A synthetic secret placed in query, Authorization, Cookie and body did not
appear in the retrieved audit page or finalized execution report. The audit
retained the original path and redaction marker, without copying the adapter
metadata. These are checks of application-returned records, not claims about
provider-internal logs or every database byte.

The failed probe combined triple slashes and two space spellings. Follow-up
isolation established:

| Synthetic input                                    | Through Supabase                    | Direct fixture          |
| -------------------------------------------------- | ----------------------------------- | ----------------------- |
| `///v1/echo?x=%2f`                                 | Signed target 404, exact path/query | Same                    |
| `/v1/echo?space=hello+world`                       | Signed target 200, exact query      | Same                    |
| `/v1/echo?space=hello%20world`                     | Signed relay 400 `invalid_metadata` | Target 200, exact query |
| `///v1/echo?space=hello+world&space=hello%20world` | Signed relay 400 `invalid_metadata` | Target 404, exact query |

The probe did not record the Function's raw inbound query, so it does **not**
prove the exact intermediate rewrite (for example `%20` to `+`). Do not widen
the validator to arbitrary decoded-query equivalence on this evidence. A
signed denial is safer than a silently different target request, but remains
an unsupported request for the user's exact-forwarding requirement.

The follow-up shared fixture `query-space-and-plus-spelling` now requires
literal `%20`, `+`, `%2b` and `%2B` spelling/order. A reference-adapter test
proves that form reserialization fails this check. Local binding tests retain
the distinction between these spellings; no runtime validation was relaxed.
The expanded suite has **not** been rerun on a hosted deployment in this run.

## Evidence, privacy and cleanup

Strict redacted acceptance report:
`.tools/acceptance/supabase-path-verified-20260913.json`; SHA-256:
`8a4db278315fb3c2f27ae6837e0040aef51d202835769bb810ad47e7fffb604a`.

Supplemental redacted result report:
`.tools/acceptance/supabase-path-diagnostic-20260913.json`; SHA-256:
`554c84a88967160f3385fb3bb47f87788d86c5ed8da8d63adb689d5ed0314d70`.

Isolated synthetic space observations:
`.tools/acceptance/supabase-space-diagnostic-20260913.json`; SHA-256:
`45aec364ff956835ab76ac8f90e26a11418f77dc02ff0eaa9847a1f873a3fd34`.

The fixture's provider settings independently confirmed persistent
observability disabled, Logpush off, no Tail Consumers, and no Node
compatibility. Only synthetic data was used. The disposable Supabase project
and Cloudflare Worker were deleted and independently confirmed absent. The
report's `cleanup=verified` describes those resources, not comprehensive test
success. All six private application credential files and their exact temporary
directory were removed after secret-canary checks across the reports/journals.

The existing project was paused with explicit user authorization and restored
after deleting the disposable project. The provider inventory confirmed
`media-center` was `ACTIVE_HEALTHY` at `2026-09-12T16:38:23Z`; the other
pre-existing project was also healthy. This is provider project-health evidence,
not a new acceptance test of that application's UI or data.

## Remaining acceptance gate

Keep the PR in draft. Resolve or explicitly narrow the encoded-space boundary,
then rerun the expanded suite against the exact future hosted build. Preserve
the 20 MiB + 1 and upstream-cancellation limitations independently. Neither the
old nor expanded suite replaces a protected-update/restore exercise or a new
three-platform release acceptance.
