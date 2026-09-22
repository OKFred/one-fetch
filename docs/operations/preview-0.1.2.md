# one-fetch 0.1.2 Preview candidate

This maintenance candidate adds explicit browser-compatible response envelopes.
It is not a 1.0 promotion and does not change protocolVersion 1, HTTP-only scope,
default empty allowlist, database schema, deployment ownership or recovery rules.
Published v0.1.0 and v0.1.1 tags and artifacts stay immutable.

## Changes

- All three adapters advertise optional `adapter.browserResponse: "envelope-v1"`.
  Explicit negotiation maps the outer response to HTTP 200; the actual target
  status and headers remain signed, and the raw response body is unchanged.
- The client requires capability advertisement, verifies mode/identity/status
  bindings and binds report monitoring to the signed target status. Transparent
  mode is still the default. No automatic outer redirect is introduced.
- Cloudflare computes streaming SHA-256 using native DigestStream and recognizes
  cancelled pipelines even when workerd fulfills pipeTo. Node now reports the
  empty-body digest. Partial bodies are never presented as integrity-verified.

See [wire behavior and verification](../protocol/browser-response.md).

## Release gates

Unit/runtime tests cover negotiation, signed-mode substitution, target statuses,
repeated cookies, empty bodies, report binding, 20 MiB boundaries and cancellation.
These are not hosted or browser acceptance evidence.

Before publishing, require successful CI and CodeQL on the final main commit,
review-bundle artifacts with checksums/SBOM/provenance, and actual Chromium
acceptance against Node, temporary Cloudflare and temporary Supabase services.
Verify cleanup and artifact identity. Do not relabel earlier v0.1.1 failures or
older success receipts as evidence for this patch. Never restore media-center.

Only after publication may xPanel pin the immutable v0.1.2 release URLs and
lockfile integrity. xPanel merge and Chrome Web Store submission remain separate
approval gates.
