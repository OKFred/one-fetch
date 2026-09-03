# Audit ledger and alerts

The application ledger is independent of provider logs. Provider logs help
diagnose runtime failures but cannot replace security and account audit events.

## Required events

- Requests: accepted, denied, completed, partial, timeout, cancelled,
  relay-error, and orphaned.
- Tunnels: accepted/denied, transport, bytes in/out, duration, and close reason;
  frames and payloads are excluded.
- Authentication: bootstrap, login success/failure/lockout, logout, TOTP,
  recovery code, password, session, refresh-family, and token lifecycle.
- Administration: configuration/rule/template/quota changes, Gateway pause,
  backup/restore/migration, alert settings, and key operations.
- Ledger operations: export, seal, retention cleanup, broken chain, failed
  append, degraded forwarding, and recovery.

Each event has stable identifiers, actor type, instance/config version,
timestamps, outcome, and a canonical UTF-8 JSON payload. The payload hash and
Ed25519 signature cover the exact bytes. Daily seals chain the day's final state
to prior seals. A generic signed Webhook can anchor seal IDs outside the primary
store.

## Redaction

Redaction happens before signing or storage. The default records path/query and
ordinary header values, then replaces configured sensitive values with
`[REDACTED]`. The following values are prohibited regardless of configuration:

- request and response bodies;
- `Cookie`, `Set-Cookie`, and `Authorization`;
- access, refresh, execution, bootstrap, or provider tokens;
- passwords, TOTP data, and recovery codes;
- certificates, private keys, and secret-store values.

Tests must use synthetic canaries to prove prohibited values cannot appear in
events, exports, Webhooks, errors, or provider-facing application logs.

## Consistency behavior

Management state and its audit event share one transaction. If the audit append
fails, the management action fails. Authentication, policy, configuration, and
quota failures are fail-closed.

For data-plane requests, availability takes priority only after authorization
and policy succeed. If the audit append then fails, forwarding may proceed while
the signed response is marked degraded. Admin, xPanel, and the configured
Webhook must surface the degradation. Recovery writes an explicit event; it does
not rewrite history.

## Retention and export

Defaults are:

- request events: 30 days;
- account, security, and configuration events: 180 days;
- daily seals: 400 days;
- execution reports: 10 minutes.

Authoritative export is JSONL plus a manifest containing instance ID, range,
schema/protocol versions, event count, byte count, hashes, key IDs, and seals.
CSV omits cryptographic fidelity and is for inspection only. Export itself is an
audited administrator operation.

An offline verifier should validate strict JSON/schema parsing, event payload
hashes/signatures, sequence continuity, daily seals, manifest checksums, and an
optional external anchor. Preserve the original export bytes if verification
fails.

## Webhook alerts

The built-in integration is a generic HMAC-signed Webhook. Payloads contain an
event ID, type, severity, timestamp, instance/config version, and a non-sensitive
summary. They exclude target details and all secrets. Delivery uses an outbox,
timestamp/replay window, receiver deduplication, exponential retry, and a final
failure alert.

Alert classes include audit degradation/integrity, storage at 70/85/95 percent,
quota at 80/100 percent, login attack/refresh reuse, token and policy changes,
Gateway pause, adapter degradation, and Control/Gateway version mismatch.

Preview adapters may expose an explicit unsupported response for alerts, backup,
or sealing work that is not complete. An empty response must not be presented as
a successful configuration.
