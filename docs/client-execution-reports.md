# Report-aware client downloads

The development client can optionally watch a trusted Control service while a
Gateway response is still downloading. This addresses the
[observed hosted stream-error hang](operations/supabase-hosted-streams-2026-09-13.md):
the Gateway may have finalized a failure even though an intermediate response
connection remains open.

## Explicit configuration

```ts
import {
  OneFetchGatewayClient,
  OneFetchExecutionError,
} from "@one-fetch/client";

const client = new OneFetchGatewayClient({
  gatewayUrl: trustedProfile.gatewayUrl,
  token: executionToken,
  capabilities: handshake.fetchOptions,
  executionReports: { controlUrl: trustedProfile.controlUrl },
});

const result = await client.executeHttp({
  method: "GET",
  targetUrl: "https://target.example/data",
  fetchOptions: { timeoutMs: 60_000 },
  signal: stopController.signal,
});

try {
  const body = await result.response.arrayBuffer();
  // Use the complete locally-read body. Perform final report/digest verification
  // separately if end-to-end integrity is required.
} catch (error) {
  if (error instanceof OneFetchExecutionError) {
    // error.code: e.g. response_too_large, timeout or cancelled.
    // error.report: validated terminal report, including timing and source.
    // result.classification still describes the original signed target response.
    // Do not log the whole report or present partial bytes as a successful body.
  } else {
    // Local Stop/timeout and network errors keep their existing error types.
  }
}
```

`executionReports` is opt-in. Existing callers without it make no extra Control
requests and keep their existing behavior. The optional `executionReports.fetch`
overrides only the Control transport; `fetch` at the top level overrides only
the Gateway transport. Custom transports must honor Fetch cancellation and
redirect semantics.

Use only the Control URL already trusted and paired by the application. The
client does not discover it from a target URL, Location header, report content
or response metadata. The same HTTPS/loopback-only URL validation applies as to
the normal Control client. This constructor does not perform a new pairing
handshake or grant browser Host permission.

## Trust and limits

- Start only for a verified, nonce-bound HTTP target response with a report ID
  and a body. Unsigned, forged, status-mismatched and Relay-error responses do
  not start a report watcher.
- Send only the execution Bearer token to the configured Control report route.
  No administrator token, ambient cookies, target headers/body or referrer are
  sent. Redirects are disabled; requests bypass caches.
- Wait one second before the first poll, then poll serially at one-second
  intervals for pending 404 reports. Temporary network/429/5xx failures back off
  to two seconds. Each attempt has a two-second deadline; at most 60 attempts
  are made, also bounded by the existing request lifetime.
- Read at most 48 KiB of strict UTF-8 JSON and validate the versioned schema.
  Match the report ID, request ID and HTTP status to the signed target response.
  Invalid, oversized, mismatched and unavailable reports cannot assert an
  execution outcome; the local deadline remains in force.
- A matching incomplete terminal report errors the readable body and aborts
  the Gateway Fetch. `OneFetchExecutionError.code` preserves the report's
  problem code; its generic message does not copy server-provided prose.
- EOF, network failure, timeout and either caller/consumer cancellation dispose
  the poll timer and any pending Control request. Late results cannot change
  the chosen local terminal state. Asynchronous source cleanup is not awaited
  before acknowledging consumer Stop.

The initial target status/headers and raw bytes are unchanged. For example, a
signed target 503 can be followed by a download timeout: the response remains a
target 503, while the thrown error's report identifies the timeout. A completed
report never closes an unfinished local download or manufactures EOF.

## Deliberate boundaries

This is a **best-effort terminal-error watcher**, not a new response-signature
scheme or end-to-end integrity verifier. The report ID is bound by the signed
response; the report document itself is fetched through the explicitly trusted,
authenticated Control channel. A report arriving after local EOF is ignored.
Fast responses may finish before the first poll and cause no report traffic.
An intermediary that converts truncation to clean EOF therefore still requires
explicit final report/length/digest verification before an integrity claim.

Missing reports, revoked credentials, unavailable Control or mismatched data
never count as completion. The unchanged local timeout remains the fallback;
the watcher cannot guarantee prompt reporting when Control is unavailable.
No retries of the original target request are performed.

## Verification and hosted gate

The new client tests cover report authentication, unsafe Control URLs, bounds,
matching, error classes, lifecycle races and cleanup. Two real loopback HTTP
cases serve three synthetic bytes and intentionally leave the response socket
open. An authenticated partial/timeout report makes the client abort that
socket before its five-second watchdog, preserving signed target 503 status.
These are **local HTTP tests**, not a full Supabase/Cloudflare/Node acceptance
run or a new 20 MiB transfer measurement.

Local verification on 2026-09-13 used pinned Node `24.20.0` and pnpm `11.25.0`:
full `pnpm check` passed (formatting, lint, strict types, workspace/tool tests,
builds, OpenAPI and security gates). Client tests now total **88** and shared
conformance tests **20**. The final report-handle hardening was separately rerun
with all 88 client tests, typecheck and lint. New/refactored client source and
test files remain below 500 lines. Generated types, migrations, OpenAPI and
lockfile are unchanged. Wrangler invocations were local types or build dry-runs,
not deployments; no cloud resource or application credential was created.

Use `--watch-reports --full` with the acceptance runner to opt in. It also
requires incomplete-response cases to finish within ten seconds, including
terminal-report retrieval, and validates report/response identity. A partial
report after a 60-second client timeout now fails that stronger gate. Baseline
runs without the flag retain their original timing semantics for comparison.

The hosted failures recorded at `0427f46` remain valid historical evidence.
The subsequent [exact-build hosted acceptance](operations/supabase-report-watch-2026-09-13.md)
at `320b91e` passed report-aware limit/timeout and established-body Stop probes,
17 executed HTTP cases and 30 path/query checks. Temporary resources and
credentials were removed and independently verified. This establishes the
opt-in client workaround, not a fix to the provider stream-reset behavior,
end-to-end integrity, upstream disconnect latency or protected update/restore.
No existing Release or xPanel integration was changed. New builds still require
their own exact-build acceptance before carrying these results forward.
