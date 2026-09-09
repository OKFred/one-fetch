# Security model

## Trust boundary

one-fetch executes administrator-authorized outbound requests. It is not a
general public proxy. Operators are responsible for the configured provider,
network egress, target authorization, TLS termination, storage, retention, and
administrator devices. xPanel treats the configured Control and Gateway as a
third party that can observe forwarded request data.

Control and Gateway must use distinct HTTPS origins. Control bearer tokens must
never be sent to Gateway. Gateway execution tokens are opaque, scoped, stored as
digests, short-lived where practical, and restricted by transport and target.

## Default and optional policy

A new instance has an empty allowlist. It denies every target until an
administrator creates a matching allow rule. This fail-closed default is not the
same thing as a blocklist.

Evaluation order is fixed:

1. strict protocol and structural validation;
2. administrator-controlled system policy;
3. xPanel user deny rules.

User rules can only deny an already permitted request. They cannot bypass or
weaken system policy.

The repository exposes a **recommended global blocklist template** for review.
It covers typical loopback, private, link-local, carrier-grade NAT, multicast,
documentation, cloud metadata, local names, recursion, unsafe schemes, and
dangerous ports. It is not hard-coded into request handling and is not silently
enabled. The administrator may adopt, edit, or reject it. Independently of that
template, an explicit allowlist still determines what can be reached.

Rules may match transport, method, origin, hostname, port, path, duplicate query
items, duplicate headers, body structure, Fetch options, redirect behavior,
WebSocket subprotocol, SNI, and ALPN. Body inspection buffers at most 1 MiB.
Rules must define what happens when a body is unavailable: allowlist checks deny
by default; blocklist checks default to no-match with a warning.

## SSRF and recursion

All adapters reject malformed URLs, userinfo, unsupported schemes, excessive
metadata/body sizes, and direct recursion to the instance. Each redirect repeats
validation. Requests carry an instance ID and hop counter to stop one-fetch
chains.

Node resolves every A/AAAA answer, evaluates candidates, and pins the selected
approved address to the connection. Cloudflare and Supabase must disclose their
runtime's weaker DNS binding guarantees. Operators should additionally enforce
egress rules at the provider/VPC/firewall layer.

## Header and Fetch fidelity

`HeaderEntryV1[]` is authoritative, but no runtime can guarantee arbitrary
wire-level headers. Hop-by-hop framing, `Host`, `Content-Length`, proxy
authentication, and runtime-reserved fields can be rejected or changed. A
capability marks each Fetch option as `exact`, `translated`, `unsupported`, or
`vendor-mutated`. Unsupported options block execution rather than disappearing.

Cloud providers may append tracing/forwarding headers or rewrite compression and
response server headers. These notices must be shown in xPanel and Admin. They
are not evidence that the target emitted those fields.

## Authentication and secrets

- The one-time bootstrap secret is stored only as a digest.
- Passwords are HMAC-SHA-256 prehashed with an instance pepper, then bcrypt cost
  12 or higher. Raw password length is bounded before prehashing.
- Access tokens default to 15 minutes; refresh tokens default to 30 days and use
  family rotation with reuse detection.
- TOTP secrets and other recoverable secrets use purpose-separated keys and
  authenticated encryption.
- Response protocol HMAC keys, audit Ed25519 keys, password peppers, provider
  keys, and bootstrap material must be generated independently.
- Secrets belong in platform secret stores or a protected service environment,
  never Git, CI artifacts, logs, URLs, command history, or support reports.

## Failure policy

Authentication, policy, quota, or configuration storage failure denies the
request. Data-plane audit append failure follows forwarding priority: execution
may continue, but signed metadata is marked degraded and a visible alert is
created. Management changes and their audit entries commit together; an audit
failure aborts the management change.

Target responses, signed relay failures, and unsigned intermediary failures are
distinct outcomes. See [architecture](architecture.md#response-source-classification).

## Reporting vulnerabilities

Do not include live tokens, cookies, request bodies, certificates, database
files, or private endpoint details in an issue. Provide a minimal synthetic
reproduction, adapter/version, capability response with secrets removed, and the
relevant audit event IDs. Use a private security advisory for exploitable flaws.
