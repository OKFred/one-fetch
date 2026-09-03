# Privacy statement

Last updated: 2026-09-04

one-fetch is self-hosted software. OKFred does not operate a one-fetch proxy,
telemetry service, account service, or request-storage backend. Installing the
software does not send request data to OKFred.

## Data flow

When a user explicitly selects a one-fetch profile in xPanel, the extension
sends the target request through the configured Gateway. The deployment operator
and its infrastructure provider can process:

- target origin, path, query, method, headers, Fetch options, and redirect data;
- target authorization and cookies when the user includes them;
- request body and selected files;
- target response status, headers, cookies, timing, and body;
- IP address, provider routing metadata, traffic size, and timestamps.

Control processes administrator credentials, device sessions, configuration,
policy, execution-token records, audit queries, and backup/alert settings. The
Admin site talks directly to the configured Control origin.

Cloudflare, Supabase, a reverse proxy, and other hosting layers may keep their
own access or security logs. Because the Gateway path/query mirrors the target
path/query, an outer provider access log may contain that path/query before
one-fetch can redact it. Operators must review provider logging and retention.

## Application audit ledger

The application ledger records security, administration, and execution events.
It can record full path/query and ordinary header values after configured
redaction. It never records request or response bodies, `Cookie`, `Set-Cookie`,
`Authorization`, access/refresh/execution tokens, passwords, TOTP secrets or
codes, recovery codes, certificates, or private keys.

Default retention is 30 days for request events, 180 days for account/security/
configuration events, ten minutes for execution reports, and 400 days for daily
integrity seals. An operator can configure shorter retention. Provider logs are
outside this application policy.

## Browser storage

xPanel stores one-fetch profile URLs and non-secret preferences locally. Access
tokens should remain in memory. Refresh tokens default to session storage and
are persisted only after the user explicitly chooses to remember the device.
Tokens, service configuration, and trust decisions are excluded from request
collections and collection exports.

Target `Set-Cookie` values are displayed as target response metadata. one-fetch
does not write them into the Gateway's cookie jar or the browser cookie jar.

## Operator responsibilities

The person or organization deploying one-fetch is the data controller for that
instance. They must disclose their identity, purposes, locations, subprocessors,
retention, legal basis, user rights, and incident contact as applicable. This
file is a software behavior statement, not a substitute for an operator's own
privacy notice.

Operators should minimize allowlists and retention, disable unnecessary provider
logging, encrypt backups, restrict Control access, rotate credentials, and
delete data when no longer needed. Users should only configure an operator they
trust and should inspect the capability/configuration timestamp before sending.

## Export and deletion

Administrators can export the application's audit ledger in JSONL with manifest
and seals. CSV is a convenience view, not the authoritative record. During
Preview, backup, restore, and deletion may require platform-native tools; see the
[backup and restore runbook](operations/backup-restore.md). Deleting an instance
does not automatically delete separately retained provider logs or backups.
