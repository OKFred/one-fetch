# Explicit browser response mode

Added in **0.1.2 Preview**, without changing `protocolVersion: 1` or the
immutable 0.1.1 release. Transparent HTTP remains the default for existing
clients. Browser Fetch with `redirect: "manual"` hides a 3xx response as
`opaqueredirect` (status 0, inaccessible headers and body), so a transparent
response cannot reliably carry a signed target redirect into a browser.

## Negotiation

Read fresh Control/Gateway capabilities before sending. Require the advertised
Fetch option `adapter.browserResponse`, value `"envelope-v1"`, fidelity
`"translated"`. Set `fetchOptions.adapter.browserResponse = "envelope-v1"`
explicitly; do not silently enable this mode or fall back when it is unsupported.
Cloudflare/Supabase still require their existing mutation consent. The SDK
rejects this option before sending when support has not been advertised.

In this mode both signed target responses and signed one-fetch errors use
**outer HTTP 200** and signed `responseMode: "browser-envelope-v1"`. Target
method, path/query, request body, redirect policy and raw response body are not
wrapped or changed. The target status, Headers, individual Set-Cookie values and
Timing remain in signed metadata. Empty and HEAD bodies remain empty.

Target Location, Content-Type, CSP and cookies are not applied as outer browser
instructions: target responses use `application/octet-stream`, `nosniff` and
`no-store`. Treat target HTML as inert data, not a page. Outer vendor-added
headers remain separate and are not target metadata.

## Verification

- Keep outer Fetch redirects `manual`; never follow an intermediary redirect
  with an execution token.
- Verify the signature, nonce and request ID, then require the signed response
  mode to equal the requested mode and the outer status to be 200.
- In transparent mode require a signed HTTP target status to equal the outer
  status. Missing/invalid metadata or mismatched identity/mode is an
  **intermediary** result, not a target or one-fetch error.
- Display the signed target status (including 3xx/4xx/5xx), not the transport
  status. Determine service errors from signed `outcome`, never outer 200.
- Bind execution reports to the **signed target status**, not the outer status.
  Only a final completed report with the matching byte count and body SHA-256
  establishes body integrity. Unavailable reports are not a successful check.

Cloudflare computes the response SHA-256 with workerd's native DigestStream,
in the backpressured response pipeline. Cancellation, size overflow and broken
streams do not produce a complete digest. Node and Supabase also report the
empty-body digest. No response buffering, database migration, new public route,
or tunneling support is introduced by this patch.

See the [Fetch opaque-redirect definition](https://fetch.spec.whatwg.org/#concept-filtered-response-opaque-redirect).
