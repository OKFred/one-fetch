# Supabase report-aware download acceptance — 2026-09-13

Exact commit `320b91e09ee01b0759f73a294ab2056a1fc419be`, build
`0.1.0+supabase.g320b91e09ee0`, passed the opt-in report-aware hosted
termination probes in a new disposable environment. Dates in the title use
Asia/Shanghai; receipt timestamps use UTC.

**This closes the three scoped client termination probes, not the entire
Preview merge/release gate.** It is a client workaround for the
[previous hosted stream-error hang](supabase-hosted-streams-2026-09-13.md),
not a repair to the provider response path. The earlier failed receipts remain
unchanged. Clients without `executionReports` retain their existing behavior.

## Exact build and isolation

- The operator approved continued temporary verification and required that
  media-center not be restored. Fresh inventory confirmed it `INACTIVE` before
  resource creation and after cleanup. No pause/restore or mutation of existing
  projects, Functions, data or application secrets occurred.
- Pinned Node `24.20.0`, pnpm `11.25.0`, Deno `2.9.6`, Supabase CLI `2.116.0`
  and Wrangler `4.128.0` were retained. The guarded deployment reran local
  preflight: **36 Control, 77 Gateway and 38 deployment-script tests**, types,
  embedded OpenAPI, migration integrity and bundle checks.
- Read-only preflight found an empty owned schema/function set. Apply recorded
  a hashed empty baseline, applied ten migrations, acquired the deployment CAS
  lease and verified the paired build at `2026-09-13T07:03:28.543Z`.
  `restoreVerified=false` remains truthful: this was first installation, not
  protected update or backup restoration.
- The clean checkout produced a 1,003,552-byte Control bundle, SHA-256
  `2bf9630fb0b7e0eeef17e696e12768eeac199a1c4717f4cfdb714fed9d43369a`,
  and an 884,267-byte Gateway bundle, SHA-256
  `2b230f2104c9ace7799f4370966c48626bd43524acb726db63ebcf25f42400b9`.
- The temporary Cloudflare target served synthetic fixtures only, with no
  proxy, bindings, secrets or persistent state. It expired after 90 minutes;
  its body-phase stream was bounded to 30 seconds. Runtime types and dry-run
  preceded deployment. Provider settings confirmed `2026-09-04`,
  `enable_request_signal`, no Node compatibility, persistent observability
  disabled, Logpush disabled and no Tail Consumers. These explicit project
  constraints take precedence over generic skill logging/Node defaults.
- Bootstrap, session listing, refresh, logout/login, exact fixture-origin
  allowlisting and a short-lived execution token passed. Credentials stayed in
  a new Windows ACL-restricted temporary directory, never command arguments.

## CI artifact identity

The exact source passed [push CI](https://github.com/OKFred/one-fetch/actions/runs/34743174264),
[PR CI](https://github.com/OKFred/one-fetch/actions/runs/34743175629) and CodeQL,
including local Supabase Docker/PostgreSQL/Function integration and review
artifacts. Hosted acceptance below is separate from those checks.

Downloaded push artifact `10313507573` contains 15 subjects plus its manifest
and two checksum lists. All 18 files passed source identity and SHA-256/SHA-512
verification. All nine client JavaScript runtime files used locally matched
the downloaded client tarball byte-for-byte. The Supabase bundles above were
locally built from that clean exact commit, not extracted from the Node OCI
archive. This did not publish an artifact or verify a Release attestation.

## Hosted regressions

The shared runner used **`--watch-reports --full`**:

- **17 executed passes + 1 explicit skip**. Target 401/429/503 stayed signed
  target results; repeated Set-Cookie stayed in metadata, not the Gateway
  cookie jar; target Server-Timing, bodies and original path/query passed.
- Exactly 20 MiB completed with all 20,971,520 bytes in **12.61 s**. This is one
  transfer observation, not a throughput comparison or final digest claim.
- 20 MiB + 1 ended with `OneFetchExecutionError`, a matching `partial` report
  and `bodyComplete=false` in **3.50 s**, including terminal-report retrieval.
  It passed the explicit ten-second deadline, not the old 60-second watchdog.
- The injected truncated-stream fixture remains skipped because the
  Cloudflare target normalizes that synthetic error. It is not a passed case.
- The separate original-path/query suite recorded **30 passes**: 20 exact
  spellings, six invalid bindings, user/system policy, redirect rebinding and
  audit/report secret canaries. No target 404 or byte-spelling expectation was
  relaxed.

## Established-body termination probes

All probes require signed target headers and a nonempty first body chunk.
The client watchdog is independently fixed at 15 seconds; only outgoing
Gateway timeout metadata is varied. The production watcher fetches reports
through its explicitly trusted Control URL using the execution credential.
Separate report collection verifies persistence but does not trigger abort.

| Probe                 | Client result                                                                   | Gateway report                                       | Result                               |
| --------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| 20 MiB + 1            | `OneFetchExecutionError` / `response_too_large` at **2.59 s**; one watcher poll | `partial`, total **1.49 s**, incomplete, no digest   | Passed <10 s                         |
| Stop after first body | `AbortError` in **0.46 ms** after Stop                                          | `cancelled`, total **1.93 s**, incomplete, no digest | Passed <250 ms local acknowledgement |
| Gateway timeout 3 s   | `OneFetchExecutionError` / `timeout` at **4.39 s**; two watcher polls           | `timeout`, total **3.00 s**, incomplete, no digest   | Passed <8 s                          |

Initial target status remained 200 in all three probes; the download error is
not substituted for those signed target headers. No incomplete stream ended
with clean EOF. Each report matched its request, stayed unchanged on reread
and had exactly one terminal audit event. Access/execution-token canaries and
synthetic query/Authorization/Cookie/body canaries were absent from audit and
report output.

Independent report retrieval occurred at 3.35 s / 2.51 s / 3.89 s respectively.
Those timestamps include polling/network delay, not exact database write time.
Gateway response byte counts are bytes read upstream, not bytes acknowledged
by the client. **Upstream socket disconnect latency was not independently
observed.** Completed-report/digest verification and unavailable-Control
fallback have separate client tests; they are not additional hosted claims here.

## Cleanup and sealed receipts

The exact temporary Supabase project `wkzqjwnqftrbpogpazrj` and both application
Functions were deleted; independent inventory confirmed absence at
`2026-09-13T07:06:52.0393270Z`. Worker
`one-fetch-fixture-bd3d3f1f8e46` was deleted and independently confirmed absent
at `2026-09-13T07:07:06.499Z`. No public Gateway remains from this run.

Only then was the shared report finalized with `cleanup=verified`. After
canary checks, all six application credential files and their private directory
were deleted. User CLI credentials were retained. media-center remained
`INACTIVE`; no restore was attempted. The temporary resources are not retained
for later recovery.

Local ignored receipts under `.tools/acceptance/`, with SHA-256:

- `supabase-watch-verified-bd3d3f1f8e46.json`:
  `67daf28c76cd448287d2aeeda5ada852dd25b1519ca80429824db02498079cd9`.
- `supabase-watch-probes-bd3d3f1f8e46.json`:
  `1b5d3ef5d0f71f998b68f90782bb2a648f92b458560fafdef36023be8b045782`.
- `supabase-watch-boundaries-bd3d3f1f8e46.json`:
  `d44956e6f402520f73dd2aaa37e4dfaf2cc27cceb219c8289850550d25a06aa0`.
- `supabase-watch-apply-bd3d3f1f8e46.json`:
  `e4736cb0d409291446ee1900dd0ac8f2c27354e2b4da0a601b1f5ac331cc03cd`.
- `supabase-watch-platform-bd3d3f1f8e46.json`:
  `66a111344700b1544d9abb0cf1a15c7303df935b94e92191cd10eb3903ead668`.
- `supabase-watch-fixture-after-bd3d3f1f8e46.json`:
  `44fa93b9021a6584cd1dd54bf49c09c953b2f926b999ba904c56f6a3fffab266`.
- `ci-320b91e-review-validation.json`:
  `84a4ee4e88e6c4b36f5fdc1fb4d9458490a6f550c6fa749ad9ff5c0940d6f893`.
- `ci-320b91e-client-runtime.json`:
  `7c6e2f476a31fe38ad6375bcdf1e83fcacb3b557dcdd152eaff555506d58fe94`.

## Remaining gates

Keep PR #15 draft. Protected update, backup/isolated restoration, upstream
disconnect and the remaining three-platform release requirements are not
established by this first-install/client-workaround run. The report watcher
must be explicitly enabled; it is not end-to-end integrity verification and
cannot guarantee prompt failure when trusted Control is unavailable.

No merge, tag, Release, existing published artifact replacement, npm publication
or xPanel change occurred. This report supplements rather than rewrites the
earlier failed and local-only evidence.
