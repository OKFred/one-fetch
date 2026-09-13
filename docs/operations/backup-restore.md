# Backup and restore runbook

Backup and restore are security operations. During Preview, platform-native
tools are authoritative; an unsupported Control endpoint must not be treated as
a backup. Production backups must be encrypted, access-controlled, kept
off-provider, and tested with a real restore. The guarded deploy tools currently
create local plaintext recovery files; operators must protect their directory
and encrypt the files before off-host transfer. They are not encrypted archives.

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

Pause Gateway, drain work, and stop other writers (including administrator and
scheduled operations) for the capture window. Gateway pause does not quiesce
Control. The separate CLI queries/dumps do **not** share a PostgreSQL snapshot;
the operator must document how writes were quiesced, or treat the capture as an
unverified recovery candidate rather than an atomic point-in-time backup.

The guarded deploy tool writes `supabase-logical-v2` with three required parts:

- `*.schema.sql`: structure of `one_fetch` and `supabase_migrations`.
- `*.rpc.sql`: only owned `public.of_*` definitions, PostgreSQL owners and
  service-role-only execute grants. Unrelated public objects are not exported.
- `*.data.sql`: data for the two schemas, using `COPY`.

The state file binds their sizes, SHA-256 digests and RPC count. Keep all three
files and the state together in their original restricted directory. Application
password/token hashes and recoverable ciphertext may be present: these files
are sensitive even though provider credentials are not included. Record the
PostgreSQL version, CLI/dump flags, immutable source build and migration checksums.
The deployment checkout must contain the current source commit so its owned RPC
inventory can be derived before updating. Missing, extra, overloaded or
unexpectedly privileged RPCs stop the backup; the tool does not broaden scope.

Verify bytes without connecting to a database:

```sh
pnpm --filter @one-fetch/adapter-supabase backup:verify --state-file <absolute-deployment-state.json>
```

This read-only command rejects missing parts, changed sizes/digests and paths
outside the state directory. Success means `integrityVerified: true`, **not**
`restoreVerified: true`. If relocating an archive, deliberately update only the
three local part paths in a working copy of the state and retain the original.

A legacy single SQL file is schema-only. A `supabase-logical-v1` schema/data pair
also omits `public.of_*` RPCs: neither is a complete functional backup. Historical
table-count-only restore results do not prove that login, configuration or quota
interfaces were restored. Do not upgrade their labels or manifests to v2.

Restore only into a separately authorized, empty project/database. Prepare the
Supabase `postgres`, `anon`, `authenticated`, `service_role` roles and `pgcrypto`
in `extensions`; do not expose PostgREST/Functions during restoration. After
verifying bytes, restore **schema → RPC → data** with `psql` and
`ON_ERROR_STOP=1`. The RPC part is transactional and restores only service-role
execute access. Do not replay destination-version migrations over the backup or
grant public access to work around a restore failure. Verify migration/RPC
catalogs, grants, stored account/session behavior and audit integrity, deploy
isolated matching Functions, then run conformance. Switch profile URLs only
after review; database restoration is never automatic.

Retain the original instance pepper and audit keys through the operator's secure
secret backup; database dumps do not replace those secrets. Change only the
destination Control/Gateway URLs for an isolated restore. Downloaded compiled
Function bundles may use `functions/<slug>/index.js`; the protected-update
inventory accepts that exact recovery layout and the normal
`.one-fetch-bundle/index.js`, not arbitrary source entrypoints. After restoration,
also verify that a subsequent protected update succeeds. See the separate
[hosted update/restore/re-update evidence](supabase-hosted-update-restore-2026-09-13.md).

### Automatic Function rollback is not database restoration

The guarded updater records a Function **attempt before invoking the CLI**.
A failed command can still have changed the remote Function. If an update fails
after any attempt, it checks the captured recovery tree digest before deploying
either old bundle. The digest frames filenames and byte lengths; changed files,
symbolic links and an unsupported recovery root stop automatic recovery.

The deployment CAS lease stays held during recovery and is renewed before each
Function write. An expired/lost lease prevents those writes. Success requires the
old Control/Gateway build handshake and a confirmed paused Gateway; CLI exit zero
alone is not sufficient. First-install cleanup instead confirms that both owned
Functions are absent. Failure handling attempts to release its own lease only
after recovery settles, and records `failureLeaseReleased: false` if release
cannot be confirmed. It must not be interpreted as a successful release.

Inspect the deployment state after failure:

- `attemptedFunctions` includes commands with uncertain remote outcomes;
  `deployedFunctions` includes only commands that returned successfully.
- `rollback.functionRollbackSucceeded` means the scoped code/absence checks
  passed, **not** that the deployment succeeded or the database was restored.
- `rollback.recoveredBuildId` and `gatewayPauseVerified` describe an update's
  verified old runtime. If recovery or lease release is unconfirmed, keep traffic
  paused, inspect provider state and resolve ownership before retrying.

Do not change instance pepper/audit keys as part of this code rollback workflow.
It does not recover previous provider secrets or reverse forward migrations.
Confirm the old bundle can run against the resulting schema; incompatible
migration recovery requires a separately authorized isolated database restore.
After a verified rollback, rerun the normal protected updater with the actual
old build as `--expected-current-build`; there is no bypass or automatic resume.

Run the repeatable local regression (Docker required, no hosted credentials):

```sh
pnpm --filter @one-fetch/adapter-supabase test:restore
```

It uses a digest-pinned PostgreSQL 17.6 container with no network or exposed
ports, validates the v2 files, restores synthetic persisted data and RPCs, and
runs the SQL suite on the restored database. It then deletes its exact container
and temporary files. This is local database evidence, not hosted Function or
protected-update acceptance.

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
