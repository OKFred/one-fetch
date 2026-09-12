# Supabase hosted revalidation — 2026-09-12

This post-release run tested commit `fb2cbf1a6ba402bc424cb98a46a62969969952bb`
(`0.1.0+supabase.gfb2cbf1a6ba4`) on a newly created disposable Supabase project.
It is **not a passing full-fidelity acceptance** and does not replace the
published `v0.1.0` release bundle.

## First-install defect and fix

The first apply on the prior main commit stopped before migrations:
`pg_dump: error: no matching schemas were found`. Neither `one_fetch` nor
`supabase_migrations` existed on this completely new database.

The corrected installer queries the exact project's schema catalog. Only a
normal first install with both schemas absent may record an explicitly empty
baseline. The record includes project identity, query SHA-256, observation time
and hashed SQL comment files; it is not a dump of other schemas or a restore
test. Invalid/unavailable catalog results fail closed. Updates and first-install
resume still require real logical dumps.

The corrected apply completed all ten forward migrations, acquired/completed the
deployment CAS lease, deployed both Functions and verified the pair/build.
Bootstrap, session listing, refresh, logout/login, exact fixture allowlisting,
execution-token creation and the audit secret-canary check completed.

## Shared HTTP suite: 15 pass, 1 fail, 1 explicit skip

JSON, urlencoded and multipart bodies, arbitrary `/v1` paths, repeated query
parameters, target 401/429/503 classification, manual redirects, repeated
Set-Cookie metadata, Server-Timing, streaming and the 20 MiB response passed.
The 20 MiB + 1 case produced a partial/incomplete execution report; the client
observed a timeout at approximately 60 seconds, not a prompt transport close.
Timeout/cancellation cases observed client TimeoutError/AbortError only; they
do not establish upstream disconnect latency.

`leading-slashes-stay-in-target-path` failed and remains a failure:

- The client emitted `/functions/v1/one-fetch-gateway//v1/echo` with the exact
  query `tag=one&tag=two&escaped=%2f`.
- Supabase's `execution.received` audit already recorded `/v1/echo`.
- The synthetic target saw `/v1/echo` and `escaped=%2F`, returning signed target
  **200**, not the required literal-path **404**.
- A direct call to the same fixture retained `//v1/echo` and `%2f`, returning
  **404**. This isolates the difference to the hosted Supabase chain; the
  application path-extraction code does not collapse repeated slashes.

The hosted ingress therefore cannot currently be advertised as preserving every
path/query byte. A compatibility design must detect/reject affected requests or
transport and validate the original path/query separately; it must not silently
rewrite requests, change the test expectation, or claim exact Node/Cloudflare
parity. No protocol change was made in this run.

Follow-up: the development branch now implements a
[capability-negotiated original-path binding](../supabase-path-binding.md) in
Protocol V1's existing adapter extension point. Its local regression coverage
does not supersede this failed hosted run. A
[separate 2026-09-13 revalidation](supabase-revalidation-2026-09-13.md) passed
the original double-slash case on the new commit, but identified a query-space
request that is rejected with signed `invalid_metadata`.

`truncated-response` was the sole explicit skip because the Cloudflare-hosted
synthetic target normalizes an injected stream failure. It is not counted as a
passing executed case.

## Evidence and cleanup

Only synthetic data was used. The fixture Worker had observability disabled,
Logpush off and no Tail Consumers. The disposable Supabase project and fixture
Worker were deleted, with separate inventories confirming absence. The report's
`cleanup=verified` describes resource cleanup, **not** test success.

The strict redacted local report is
`.tools/acceptance/supabase-path-verified-20260912.json`; SHA-256:
`7641c2b1e136282370d5d98128109b6f70fb5058a366039c32d84efb39ad95ce`.
Minimal synthetic path observations and deployment journals are retained locally;
no Token, Header value or body is included in the acceptance report.

With explicit user authorization, an existing project was temporarily paused
to free the account's project slot. After deleting the test project, it was
resumed and the provider inventory confirmed `ACTIVE_HEALTHY` at
`2026-09-12T14:18:03Z`; the other pre-existing project remained healthy. All six
local application credential files and their private temporary directory were
removed after report-canary checks. No pre-existing application data was used
in the tests.

No Release/tag was replaced and xPanel was not changed. Local `pnpm check`
passed, separately from the hosted failure above.
