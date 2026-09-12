# Supabase hosted stream revalidation — 2026-09-13

Tested commit `0427f46e321f888ab2b1155a1e783481e2558a1a`, build
`0.1.0+supabase.g0427f46e321f`, in a new disposable project. Dates in this
title use Asia/Shanghai; receipt timestamps use UTC.

**The prompt stream-termination gate remains open.** Established-response Stop
now has a real client and terminal-report observation, but stream limit and
Gateway timeout errors still do not promptly terminate the hosted response at
the client. Passing ordinary HTTP conformance does not override those failures.

## Isolation and deployment

The operator explicitly approved this new temporary environment and instructed
that media-center must not be restored. Fresh inventory found it `INACTIVE`;
this run performed neither pause nor restore. Existing projects, databases,
Functions and application secrets were untouched.

The new project completed read-only preflight, empty-schema baseline capture,
ten migrations, deployment CAS, paired Control/Gateway deployment and exact
build verification at `2026-09-12T20:55:41.865Z`. The empty baseline still has
`restoreVerified=false`; this was not an update or recovery exercise.

Pinned Node `24.20.0`, Deno `2.9.6`, Supabase CLI `2.116.0` and Wrangler
`4.128.0` were retained. Preflight reran **36 Control, 77 Gateway and 38
deployment-script tests**, types, migration/OpenAPI checks and bundle checks.
The exact staged Gateway was 884,267 bytes, SHA-256
`fdde6c77a3b5b17c6439fdcab54b071547f5c8e6713827548fa26af2a86e7601`.

The temporary Cloudflare target only served synthetic fixtures. A bounded
30-second stream emitted 64 KiB every 500 ms for body-phase probes. It had no
proxy, bindings, secrets or persistent state. Per Cloudflare/Workers/Wrangler
guidance, a dry-run preceded deployment and provider settings were checked:
compatibility date `2026-09-04`, `enable_request_signal`, no Node compatibility,
persistent observability disabled, Logpush disabled and no Tail Consumers.

Bootstrap, session listing, refresh, logout/login, exact fixture allowlisting
and execution-token creation passed. Tokens were read from restricted local
files, never command arguments or reports.

## Existing regressions

The shared HTTP suite recorded **17 executed passes and one explicit skip**.
The original-path/query boundary suite recorded **30 passes**, including
missing/forged bindings, system/user policy, redirect paths and secret canaries.
No expectation was changed to accept these results.

Exactly 20 MiB completed in **4.41 s**. The existing 20 MiB + 1 case still hit
its client timeout after **60.65 s** with a finalized `partial` report and
`bodyComplete=false`. Its passing assertion verifies incomplete classification,
not prompt termination. The synthetic truncated-stream case remains skipped
because the Cloudflare target normalizes its injected error.

## Stronger body-phase probes

These use signed target headers and wait for the first non-empty body chunk.
The client's 15-second watchdog is independent of the requested Gateway timer;
only `timeoutMs` is varied in outgoing metadata. Request ID, nonce, original
path binding and response signature verification remain intact.

| Case                  | Client observation                                                       | Gateway terminal report                                                           | Prompt termination |
| --------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------ |
| 20 MiB + 1            | Headers at 0.61 s; 20,955,418 bytes received; client watchdog at 15.02 s | `partial`, `response_too_large`; Gateway total 1.02 s; report retrieved at 2.04 s | **Failed**         |
| Stop after first body | First body at 0.58 s; Stop returns `AbortError` in **1.34 ms**           | `cancelled`; Gateway total 0.79 s; report retrieved at 2.06 s                     | **Passed**         |
| Gateway timeout 3 s   | First body at 0.55 s; 393,216 bytes received; client watchdog at 15.01 s | `timeout`; Gateway total 3.00 s; report retrieved at 3.66 s                       | **Failed**         |

All three reports matched their request IDs, remained unchanged on reread,
had exactly one terminal audit event, and contained no complete-body hash.
The audit pages and reports passed access/execution-token canary checks.
Report retrieval times include polling and network latency; they are not exact
database write times. Gateway byte counts describe bytes read from upstream,
not bytes acknowledged by the client. Upstream socket disconnection was **not
independently observed**.

## Minimal reproduction outside one-fetch

A third, random-named Function in the same disposable project contained no
one-fetch imports, authentication logic, database access, upstream fetch or
logging. It accepted only two synthetic GET paths, expired after 20 minutes,
sent one 64 KiB chunk and, 500 ms later, either closed or errored its stream:

```ts
controller.enqueue(new Uint8Array(65_536).fill(42));
setTimeout(() => {
  if (kind === "error") controller.error(new Error("synthetic source failure"));
  else controller.close();
}, 500);
```

Direct Node Fetch, without the one-fetch client, observed:

- `close`: all 65,536 bytes and clean EOF, about **0.50 s after first body**
  (1.83 s including cold start/network).
- `error`: all 65,536 bytes, then no terminal stream signal before the
  **8.02 s client watchdog**.
- Independent `curl.exe --http1.1 --max-time 8` also received 65,536 bytes and
  then exited with cURL error 28 at **8.006 s**. No body was saved.

This reproduces the behavior without one-fetch stream cleanup or report
finalization. It locates the remaining symptom on the hosted response path,
but does **not** identify the exact internal provider component. It does not
justify substituting clean EOF for an incomplete response or injecting an
error into the target's raw body.

## Cleanup and evidence

The exact temporary Supabase project `vracrepgvmfnjafokxko` was deleted with its
two application Functions and diagnostic Function. Independent project
inventory confirmed absence at `2026-09-12T20:59:57.1429284Z`. The exact Worker
`one-fetch-fixture-59876b26e8ec` was deleted and independently confirmed absent
at `2026-09-12T21:00:12.502Z`. No public Gateway remains.

After those checks, the shared report was finalized with `cleanup=verified`.
That field describes resource cleanup, **not** a passing stream-termination
gate. The separate stronger-probe report intentionally retains `passed=false`.
All six temporary application credential files and their restricted directory
were removed after canary checks across the receipts. User CLI credentials
were retained. **media-center remains INACTIVE; no restore was attempted.**

Local ignored receipts and their SHA-256 values:

- `supabase-stream-verified-59876b26e8ec.json`:
  `275c3cd3ded5e9e9ef18ffa41663431d448afc4408bc1585033a03d386ad19db`.
- `supabase-stream-probes-59876b26e8ec.json`:
  `9d40dfba598e427a9978854f3181a4be17533d66b5e2b256c46e569888823494`.
- `supabase-stream-boundaries-59876b26e8ec.json`:
  `fb63441b86f65f89731c86615e3b669e449df8241dee37dea04c63950f13385b`.
- `supabase-stream-minimal-59876b26e8ec.json`:
  `1b27c367500e746b8b8d707e125c27e02a78857af2bd4edd95372d6ac393115b`.
- `supabase-stream-curl-59876b26e8ec.json` (transcribed native output):
  `d11029a318a94b5930a2f575fb2665dee00f56e5aab10a8d9ced2f7e99a9e0ce`.
- `supabase-stream-apply-59876b26e8ec.json`:
  `c5aefb1be9ff0d42a64155d378a933a8edf32ca9a03305018a6c3939a3083374`.
- `supabase-stream-platform-59876b26e8ec.json`:
  `2795ab0f3a0caed53a75dd952f36d312d1fea87f3fbe9709d938e044407c1e84`.

All are under `.tools/acceptance/`. The diagnostic source is retained locally;
its SHA-256 is `fc5875b266a5e678a9d089dacc528a7dfd99dc5be857ec58a62a4f5208820932`.

## Next gate

Keep PR #15 draft. The local ordering fix remains valid, but the hosted prompt
limit/timeout termination gate is still failing. A possible follow-up is a
bounded, authenticated Control-report watcher that actively aborts the client
when the matching execution has finalized incompletely. It must preserve
target/relay classification, handle unavailable/stale reports, and never turn
truncation into success. That is a proposal, **not implemented or accepted by
this run**; provider stream-reset behavior and upstream disconnect remain
separate verification boundaries.

No PR merge, tag, Release, published artifact replacement or xPanel change was
performed. Prior failed, exact-query and local-only reports remain historical
evidence rather than being overwritten by this run.
