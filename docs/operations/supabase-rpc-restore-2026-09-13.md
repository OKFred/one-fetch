# Supabase owned RPC backup and local restore evidence — 2026-09-13

This is an additional local database gate for draft PR #15, not hosted update,
Function restoration, a new Release, or an authorization to restore media-center.

## Defect and scope

The former `supabase-logical-v1` backup selected only `one_fetch` and
`supabase_migrations`. Its schema/data files omitted all `public.of_*` functions.
Restoring those files could reproduce tables and rows while leaving login,
configuration, quota and deployment RPCs absent. Historical restore receipts
are retained; their table-count checks must not be read as functional RPC
restore evidence.

The v2 backup adds owned RPC definitions, owners and service-role-only ACLs and
binds all three files by size and SHA-256. It derives the expected RPC inventory
from the immutable current source build, rejects missing/extra/overloaded APIs
or unsafe privileges, and checks public RPCs even if application schemas are
absent. Unrelated public objects are not included. The backup is read back before
forward migrations. A separate verifier never runs SQL or marks restoration
successful merely because checksums match.

## Verified implementation

- `74cbd46`: owned RPC catalog, source inventory and privilege validation.
- `58bf49a`: v2 schema/RPC/data manifest, verification and deployment integration.
- `84c317b`: isolated PostgreSQL restore regression and CI gate.
- `bb38d406b92ae913679ccdadfa755f27144cb857`: wait for the final TCP-ready server,
  avoiding the image's temporary initialization server.

The first committed rerun caught the readiness race; it failed before migration
and cleaned its exact container. The corrected committed implementation was
rerun successfully. Failed evidence has not been overwritten.

## Real local PostgreSQL result

Command: `pnpm --filter @one-fetch/adapter-supabase test:restore` (optional
`--report <new-local-path>` writes a redacted receipt).

The exact `bb38d40` run used PostgreSQL **17.6**, image digest
`sha256:b3bfedb107413abb3b8cb0d0874b0414a1dceb3d55bc0c778de6ad22d1f7dc86`,
Node **24.20.0**, an isolated Docker container with network disabled, no published
ports and tmpfs data. Only synthetic database data was used.

Verified:

- The legacy schema/data pair restores **zero** public one-fetch RPCs.
- The v2 backup restores **39 RPCs** with identical definitions/owners/ACLs.
- All **16 application tables** have identical row content after restoration;
  both application migration integrity and **10 provider migration rows** survive.
- Stored synthetic account lookup and access-session authentication RPCs work as
  `service_role`. `anon` and `authenticated` cannot invoke account lookup.
- An unrelated public table is excluded from the backup and restored database.
- All **7 existing SQL suites / 144 assertions** pass on the restored schema,
  covering privileges, auth safety, control hardening, execution lifecycle,
  finalization failures, migration integrity and deployment CAS.
- The exact container and temporary backup directory are deleted, and the
  ownership-label inventory is independently checked empty by the runner.

Local receipt: `.tools/acceptance/supabase-rpc-restore-committed.json`.
SHA-256: `2237c468de03ce0d52cd0f53a8b9352be80ed6676b765cf9000e09416497de55`.
It contains no account values, tokens, headers, SQL bodies or response data.

## Other local gates

Full `pnpm check` exited **0**: formatting, type-aware lint, strict types,
workspace tests, 84 tool tests, production builds/dry-runs, OpenAPI and security
boundaries. Supabase deployment scripts now pass **50 tests**, including
three-part corruption, missing RPCs, invalid ACLs and first-install leftovers.
Changed authored implementation files remain below 500 lines. No dependency,
lockfile, migration, runtime protocol or generated Env change was needed.

Check log: `.tools/acceptance/rpc-pnpm-check.log`.
SHA-256: `42d88fbd8d752924707675632c02b1c2cefc71379369ada36a192310097cc16c`.

The separate initial diagnostic container was also removed by exact ID after
checking its ownership label and disabled network. No temporary cloud resources
or application credentials were created during this local checkpoint.

## Remaining gates

Keep PR #15 draft. This run uses real PostgreSQL/pg_dump but not the hosted
Supabase management API, CLI transport, PostgREST or Edge Functions. It does not
prove login password verification, encryption-key restoration, browser UX,
protected online update/rollback or a restored hosted HTTP Gateway. Those must
be tested separately on explicitly isolated resources.

The backup files are plaintext and the separate dumps do not share an atomic
database snapshot. Operator-controlled writer quiescence and encryption remain
mandatory; Gateway pause alone does not stop Control writes. See the
[backup runbook](backup-restore.md#supabase-postgresql).

No existing database was restored or modified, media-center was not restored,
and no merge, tag, Release, published artifact replacement or xPanel change was
performed. The earlier hosted stream and report-watcher evidence retains its
own exact-build scope.
