# Permissions and network access

one-fetch does not grant browser permissions. It accepts authenticated network
requests from xPanel and the static administration site. The browser extension
and each deployment remain separate security principals.

## xPanel

xPanel should retain `storage` as its required extension permission and request
HTTP/HTTPS host access only for the user-selected target or configured one-fetch
origins. one-fetch does not require `cookies`, `nativeMessaging`, blocking
`webRequest`, declarative network rules, or broad mandatory host access.

The extension asks before first use of a profile and shows the target origin,
Gateway host, data categories leaving the browser, capability mutations, and
configuration timestamp. Trust lasts only for the Chrome session and is revoked
when an endpoint, token, signing identity, or configuration changes.

## Control access

Control accepts only configured Admin origins and uses its own administrator
opaque access token. CORS is not authentication. Operators should also restrict
Control at the firewall/provider layer and never expose it through the Gateway
hostname.

The report endpoint is a narrow exception: it accepts the execution token that
owns the short-lived report. It does not accept a target authorization value or
silently elevate an Admin token.

## Gateway access

Gateway accepts one-fetch protocol metadata and an opaque execution token. Each
token has transport scopes, narrower origin/port policy, rate/concurrency/byte
quotas, and revocation state. Target `Authorization`, `Cookie`, proxy credentials,
and certificates are request data, not Gateway credentials.

Gateway performs outbound access only after strict validation, system policy,
user deny policy, quota, recursion, and capability checks. Unsupported Fetch
options or transports deny execution. Redirects repeat these checks.

## Platform privileges

- Cloudflare Control binds only its D1 database, Auth/Quota Durable Objects,
  scheduled maintenance, and required secrets. Gateway binds only Control and
  its public configuration.
- Supabase functions use service-role access internally while SQL revokes the
  application schema/RPCs from public, anonymous, and authenticated roles.
- Node runs as non-root, writes only its data/temp paths, reads only explicitly
  configured CA/client files, and receives outbound network access constrained
  by system egress rules.

Build and pull-request workflows receive read-only repository access and no
provider credentials. The manual review workflow receives only GitHub OIDC and
attestation permissions; it cannot deploy or create a Release.
