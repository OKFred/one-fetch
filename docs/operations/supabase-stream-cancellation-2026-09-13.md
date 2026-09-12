# Supabase response cancellation: local regression — 2026-09-13

This is a **local code/regression result**, not a new hosted acceptance run.
The preceding [hosted exact-query run](supabase-exact-revalidation-2026-09-13.md)
still records a 20 MiB + 1 client timeout after 60.70 seconds at `8fc5fa2`.
That evidence is not replaced or relabelled by this fix.

## Reproduction

At parent commit `2eaf345`, seven new deterministic stream tests produced
**five failures and two passes** under pinned Deno `2.9.6`:

- An oversized response waited for the source's `cancel()` promise before
  rejecting its downstream reader.
- A pending read did not directly react to its AbortController's `AbortError`
  or `TimeoutError` if the source did not propagate the signal itself.
- A pre-aborted stream could still forward its buffered chunk.
- Consumer cancellation awaited source cleanup, preventing prompt Stop
  acknowledgement.

The fixture deliberately leaves source cleanup pending until the assertion
finishes, then releases it. Its 100 ms watchdog detects ordering/deadlock, not
an internet performance promise. No real upstream, database or provider is
contacted by these fixtures.

The implementation awaited `reader.cancel()` before calling the downstream
controller's `error()`. Stream cancellation can include asynchronous underlying
source cleanup; it is not guaranteed to finish immediately. See the
[Streams Standard cancellation model](https://streams.spec.whatwg.org/#rs-cancel).
This explains the reproduced local failure, but **does not prove** that this
await was the only cause of the previously observed hosted timeout.

## Change

The Supabase response monitor now:

- Rejects downstream immediately on an observed response limit or abort signal,
  and handles signals already aborted when the monitor is created.
- Requests upstream cancellation without awaiting it on the downstream path.
  Its handled cleanup promise is registered through the existing runtime
  `waitUntil` helper; it is not treated as a verified network disconnect.
- Detaches its abort listener and ignores reads arriving after a terminal
  decision. Completion, error and cancellation can finalize only once.
- Schedules finalization independently so cleanup does not block the report or
  a downstream Stop. Existing problem codes and signed report identities remain
  unchanged; incomplete bodies do not acquire complete-body digests.

No protocol, database migration, dependency, Node/Cloudflare adapter, published
artifact or xPanel change is included. Declared-size rejection before target
headers and other upload/redirect cleanup paths are outside this change.

## Verification layers

- **Stream regression:** all seven new cases pass. Existing digest, limit and
  terminal-classification tests also pass.
- **Gateway handler:** three additional cases use the real handler with
  synthetic database/upstream ports. They verify the initial target signature
  against the original nonce/request ID, pending-source cleanup, single final
  report/audit, preserved `partial`/`cancelled`/`timeout` classification and no
  late success. The timeout case must reach target body streaming before its
  real Gateway timer expires.
- These are not a raw HTTP wire test, PostgreSQL restore exercise, hosted
  Supabase deployment or client-to-provider/upstream disconnect measurement.

Full local `pnpm check` passed: formatting, type-aware lint, strict types,
workspace tests, 84 tool tests, production builds, OpenAPI and security gates.
Supabase now has **36 Control + 77 Gateway + 38 deployment-script tests**;
Cloudflare's 58 runtime tests also passed. Generated migration/OpenAPI/type
files and the lockfile remain unchanged. The final fixture-cleanup edits were
rerun with their targeted Deno tests and lint checks.

Both self-contained Supabase bundles passed inspection. The Gateway check
bundle is 884,252 bytes, SHA-256
`2fdcbb5e6bb743ae805c1017ebc98c06cf55fffc5a3e55dbb5ccc0cf502af54e`.
This is a local check bundle, not a released or remotely deployed build.
Changed implementation/test files are 95, 268 and 184 lines, below the preferred
500-line limit. Wrangler checks remained local/type checks or deployment
dry-runs; no deploy or remote-binding command was used.

Reproduce from the repository root with pinned Node `24.20.0` and pnpm `11.25.0`:

```bash
pnpm --filter @one-fetch/adapter-supabase test
pnpm --filter @one-fetch/adapter-supabase bundle:check
pnpm check
```

The target helper restores its intercepted Fetch function, releases synthetic
cleanup gates and cancels unfinished requests in `finally` blocks. No temporary
cloud resource, application credential or existing project data was created or
changed in this local run. media-center was not restored.

## Remaining gate

Deploy and verify the exact future build only after the appropriate hosted-run
authorization. Retain the previous original-path/query fixtures and measure
20 MiB + 1, established-upstream cancellation and terminal report timing
separately. Do not interpret passing local tests or CI as resolution of the
hosted 60.70-second timeout, and do not relax conformance expectations to make
that timeout count as prompt termination.

## Subsequent hosted verification

After explicit approval, the [hosted stream rerun](supabase-hosted-streams-2026-09-13.md)
tested `0427f46`: established-response Stop passed, but prompt limit/timeout
termination still failed. A minimal Function without one-fetch reproduced the
errored-stream hang with Node Fetch and cURL. This local regression remains
valid; it must not be presented as a resolution of the hosted response path.
