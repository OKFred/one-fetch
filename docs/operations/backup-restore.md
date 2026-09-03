# Backup and restore runbook

Backup and restore are security operations. During Preview, platform-native
tools are authoritative; an unsupported Control endpoint must not be treated as
a backup. Every backup is encrypted, access-controlled, kept off-provider, and
tested with a real restore.

## Backup contents

Capture the primary database, migration table/checksums, instance/config
version, audit JSONL/manifest/seals, public audit verification keys, deployment
manifest, immutable source/artifact digest, and provider configuration needed to
recreate bindings. Export secrets separately from the platform secret store;
never put plaintext secrets in the database archive or CI artifact.

Record timestamp, operator, source instance, schema version, consistency method,
file sizes, SHA-256/SHA-512, encryption method/key reference, retention class,
and restore rehearsal result. Audit the export without recording its contents.

## Node SQLite

1. Pause Gateway and wait for active requests/tunnels to close.
2. Stop both listeners and the SQLite Worker Thread cleanly.
3. Copy the database to a newly created restricted directory. Do not omit a WAL
   or SHM file from an unclean database; restart and checkpoint/stop cleanly or
   use a supported SQLite online-backup operation.
4. Hash and encrypt the copy before moving it off-host.
5. Restart the original only after backup metadata is durable.

Restore into a new path with the service stopped. Check file ownership,
`PRAGMA integrity_check`, migration checksums, audit chain/seals, and runtime
startup probes. Start on isolated ports, run conformance, then switch traffic.

## Cloudflare D1

Pause Gateway and drain work. Export the exact remote D1 database with the pinned
Wrangler version into a restricted local path. Save D1 identity and Worker/
Durable Object version metadata. Durable Object state that is not represented in
D1 requires an adapter-supplied export/reconciliation step; do not claim a
complete backup without it.

Restore into a newly created D1 database, apply only required forward migrations,
import the export, verify row counts/migration hashes/audit seals, deploy isolated
Control/Gateway workers, run conformance, then change bindings/traffic. Keep the
old database read-only through the rollback window.

## Supabase PostgreSQL

Pause Gateway and drain work. Use the pinned Supabase/PostgreSQL tooling to make
a consistent schema-and-data dump from the explicit project. Include non-public
schemas, functions, grants, migration history, and audit data; exclude provider
credentials. Record the PostgreSQL version and dump flags.

Restore into a separate project/database using a restricted owner. Revoke public
roles before exposing functions, verify migrations/RPC grants/audit seals, deploy
isolated functions, and run conformance. Switch profile URLs only after review.

## Required restore drill

At least once per release candidate and on a schedule in production:

- restore to an isolated destination without overwriting existing data;
- prove wrong-key/corrupt/truncated backups fail safely;
- verify login/token revocation, policy/config version, quotas, audit continuity,
  execution-report TTL, and Webhook outbox behavior;
- run target/intermediary/error classification and redaction canaries;
- document recovery point/time and securely destroy the rehearsal copy.

Never report “backup verified” from archive creation or checksum validation
alone. A clean, behaviorally accepted restore is the evidence.
