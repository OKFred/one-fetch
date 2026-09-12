# Architecture and protocol boundary

## Components

An installation has two network origins and one optional static administration
site:

1. **Control** owns authentication, configuration, policies, execution tokens,
   capabilities, audit queries, alerts, backups, and short-lived reports. Its
   routes are versioned under `/api/v1/*`.
2. **Gateway** owns no application path. The request path and query after the
   configured Gateway base are the target path and query.
3. **Admin** is a static Vue application. It calls Control directly and has no
   server-side BFF.

Cloudflare and Supabase necessarily have provider routing before the Gateway
entry point. That provider prefix is part of the configured Gateway base, not a
one-fetch route. Node uses a dedicated Gateway listener.

## HTTP request path

```text
xPanel
  |  target path/query + raw body + X-One-Fetch request metadata
  v
Gateway -- authenticate --> policy --> quota --> target origin + same path/query
  |                                             |
  | signed response metadata + target body      | target status/headers/body
  +---------------------------------------------+
```

Protocol metadata contains the target origin, ordered `HeaderEntryV1[]`, Fetch
options, nonce, request ID, body declaration, redirect policy, and optional user
deny rules. The wire limit is 48 KiB for decoded metadata and 20 MiB each for
request and response bodies. Defaults are a 60-second timeout and 20 redirects.

Initial target paths are joined after the declared origin, never resolved as
relative URL references: `//v1/items` remains that literal path on the declared
host. Client composition, policy normalization, adapter forwarding, and audit
must agree on it. This differs from an upstream `Location: //other.example/x`,
which is a real cross-origin redirect and still requires destination checks and
credential stripping. Providers may normalize a URL before it reaches a Gateway;
local path-preservation tests do not establish hosted-provider behavior.

Native `Headers` is never the authoritative stored representation. This keeps
ordering and duplicates visible for policy and audit decisions. A runtime may
still merge ordinary duplicate headers at its network boundary; capabilities
must identify that as `vendor-mutated` rather than claiming exact behavior.

Target `Set-Cookie` values are carried one-by-one inside signed response
metadata. They are displayed to the client and are never emitted as Gateway
cookies. Request-side `Cookie` and target `Authorization` remain target data and
must not authenticate the Gateway itself.

## Response source classification

Every request uses a 128-bit nonce. The response signature binds at least the
nonce, request ID, outcome, target status (when present), and configuration
version. Responses use `Cache-Control: no-store`.

| Client classification | Meaning                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`              | Valid signature and target outcome. Any target status, including 3xx, 4xx, and 5xx, is a normal target response.                                                                   |
| `relay-error`         | Valid signature and a structured one-fetch problem with origin and stage.                                                                                                          |
| `intermediary`        | Metadata is absent, malformed, stale, nonce-mismatched, or has an invalid signature. Treat the HTTP status/body as produced by a provider, CDN, reverse proxy, or other middlebox. |

Clients must validate metadata before interpreting an outer status as the target
status. They must never turn an unsigned provider error into a target response.

## Redirects

Gateway redirects are handled explicitly, not delegated to automatic Fetch
follow behavior. Each destination is revalidated against policy. Cross-origin
redirects remove authorization, cookies, and other origin-bound credentials.
Bodies are replayed only when the adapter can do so safely; otherwise the
redirect is returned for user confirmation.

## Tunnels and protocol upgrades

All three `0.1 Preview` adapters expose only HTTP. WebSocket, TCP, and TLS are
reported as unsupported, and upgrade attempts are rejected before an upstream
connection is created. The following protocol shape is reserved for later
versions and is not a shipped runtime path in `0.1`.

The browser-facing WebSocket negotiates only `one-fetch.v1`. Before any upstream
connection is opened, the first client text frame must be a valid
`TunnelClientHelloV1` containing the execution token and request metadata. The
first server frame is a signed `TunnelServerHelloV1`; binary forwarding starts
only after acceptance.

TCP and TLS use the same authenticated first-message policy boundary. Tunnel
audit records contain connection times, byte counts, duration, and close reason,
not frames or payloads. An adapter must advertise a transport as unsupported
until runtime probes, backpressure tests, and real-environment conformance pass.

An HTTP `101` without the tunnel handshake is not transparently promoted. xPanel
must select the WebSocket executor explicitly. Other protocol upgrades are
reported as unsupported.

## Timing

`Server-Timing` belongs to the target and is preserved separately from
Gateway-observed timing. Node can measure DNS, TCP, TLS, time to first byte, and
download phases when a connection is newly created. Connection reuse, a proxy,
or a platform runtime can make individual phases unavailable.

Cloudflare Workers and Supabase Edge Functions do not expose reliable target
DNS/TCP/TLS phase measurements. They report those phases as unavailable rather
than zero. All adapters can report the Gateway-observed policy/auth duration,
upstream elapsed time, download duration, and total elapsed time when measurable.

Final body size, digest, completion state, and integrity result are available in
a Control execution report for ten minutes by default. Report lookup requires
the same execution token and is not an administrator bearer-token shortcut.

## Shared and adapter-specific code

`packages/core` uses Web-standard APIs only. Platform storage, sockets, DNS,
service bindings, and request entry points remain in adapters. Static import
checks reject Node, Cloudflare, Deno, and Supabase dependencies in the shared
core. Conformance fixtures describe observable behavior and are run against
real adapter entry points before a stable release.
