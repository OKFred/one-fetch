# xPanel integration boundary

xPanel 3.0 consumes one-fetch only after a reviewed protocol artifact exists. It
does not copy protocol source and does not use an unpinned branch or npm package.

## Profile

A profile stores separate HTTPS Control and Gateway URLs. Neither URL may have
userinfo, query, or fragment. The Gateway base may include a provider function
prefix, but xPanel appends the exact target path/query after that base.

Profile configuration includes no target request, collection, or exported
credential data. Access tokens remain in memory. Refresh tokens default to the
Chrome session and are persisted only after a second confirmation.

## Connection handshake

Before sending, xPanel fetches capabilities and verifies:

- supported protocol and adapter version;
- distinct Control/Gateway origins;
- instance ID and response-signing material;
- configuration version and update timestamp;
- target/transport limits and Fetch option fidelity;
- known provider header mutations and timing gaps;
- audit health/degradation and Gateway pause state.

The UI displays adapter, configuration version, and `configUpdatedAt` beside the
executor. A changed endpoint, token, signing identity, or configuration invalidates
the session trust prompt.

## Execution behavior

Remote execution is always selected explicitly. Browser-incompatible headers may
offer “filter once,” “switch to a chosen one-fetch profile,” or “cancel”; xPanel
never sends remotely without selection and disclosure.

The Gateway receives target data through protocol metadata plus the raw body.
xPanel must preserve duplicate query/header items and surface any capability
marked translated, unsupported, or vendor-mutated. Unsupported fields block
sending.

Signed metadata decides whether a result is a target response or relay error.
Unsigned, invalid, nonce-mismatched, or stale metadata is shown as an
intermediary/provider response. Target `Set-Cookie` is shown and copyable but is
not written into Chrome cookies.

Progress uses real phases and byte counts. Unknown totals stay indeterminate.
Stop aborts the active Browser or one-fetch request, enters a single cancelling
state, and prevents a late result from replacing the last successful response.
The default timeout is 60 seconds.

## Artifact locking

xPanel locks the protocol and client archives by immutable GitHub Release URL,
SHA-512 integrity, and release tag. The lock update records the source release,
checksums, provenance verification, schemas, conformance result, and supported
protocol range. A checksum change under an existing tag is a security failure;
tags are never moved or reused.

The legacy Remote Relay protocol is removed only after Browser and one-fetch
real-environment migration acceptance passes. xPanel merge, extension packaging,
Chrome Web Store submission, and one-fetch deployment remain separate approvals.
