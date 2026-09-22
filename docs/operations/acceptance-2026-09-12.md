# Cloudflare path-fidelity revalidation — 2026-09-12

This is post-release HTTP revalidation, not a replacement for the published
`v0.1.0` acceptance bundle or evidence of a new Supabase hosted run.

## Tested source and result

- Gateway/Control commit: `76b1d2975f4351d446daa5d35774602ddfe7e55b`.
- Report build: `0.1.0+76b1d2975f4351d446daa5d35774602ddfe7e55b`.
- Runner: Node 24.20.0; deployed with Wrangler 4.128.0 and compatibility date
  `2026-09-04`, without Node compatibility.
- The full shared suite had 16 passing cases and one explicit platform skip.
- `//v1/echo` stayed inside the selected target origin and reached the target
  as a literal double-slash path, producing a signed **target 404**. Duplicate
  query parameters and percent-escape spelling were preserved.
- JSON, form and multipart bodies, target 401/429/503 classification, manual
  redirect, repeated Set-Cookie metadata, Server-Timing and streaming passed.
- A 20 MiB response completed; 20 MiB + 1 was bounded at 20 MiB and its execution
  report marked the body incomplete with a `partial` outcome.
- Timeout and cancellation cases observed client `TimeoutError` and
  `AbortError`. These observations alone are not proof of upstream disconnect
  timing.
- `truncated-response` remained explicitly skipped: a Workers-hosted synthetic
  target cannot reliably inject that failure through the platform. This skip
  must not be counted as an executed passing case.

## Privacy and cleanup

Only synthetic data and one exact temporary target allow rule were used. The
three deployed Workers had persistent observability disabled, Logpush off and
no Tail Consumers. Cloudflare's script-settings API represented disabled
observability as `null`; local deployment configs explicitly set `enabled:false`.

The temporary Control, Gateway, fixture Worker, D1 database and both Auth/Quota
Durable Object namespaces were deleted. Separate provider inventory confirmed
their absence before the report was finalized with `cleanup=verified`. The
four local secret/credential files were also deleted; non-secret local dry-run
files are not release artifacts.

The strict, redacted local report is
`.tools/acceptance/cloudflare-path-verified-20260912.json`. Its SHA-256 is
`cd081bc7876ee82ca192abbb5a3bdeb7f61dc1d3ff815df8087eb01910df3b75`.
No credential, Header value or body is included in that report.

## Remaining boundary

At the end of this Cloudflare run, Supabase hosted revalidation was pending: the account had
no free project slot and the local CLI needs authentication. Existing active
projects were not paused or modified. Node local conformance and the earlier
Supabase acceptance remain separate evidence; neither substitutes for this
missing hosted run.

A subsequent authorized disposable Supabase run is recorded in
[Supabase hosted revalidation](./supabase-revalidation-2026-09-12.md). It exposed
an empty-database installer defect (fixed) and a hosted path-normalization
failure (still open). Do not treat that run as a passing full-fidelity gate.

No Release asset was replaced, no new version was published, and xPanel was
not changed.
