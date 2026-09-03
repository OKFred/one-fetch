# Supply-chain controls

## Dependency policy

- pnpm and direct dependencies use exact versions; the lockfile is frozen in CI.
- Workspace dependencies use `workspace:*` only in source manifests. Release
  package manifests replace them with immutable GitHub Release artifact URLs.
- pnpm enforces minimum package age, no dependency downgrade, blocked exotic
  subdependencies, strict lifecycle build approval, and an explicit allowlist.
- Install/publish lifecycle scripts are rejected by a repository check.
- Shared `packages/core` imports are parsed with the TypeScript AST and cannot
  import Node, Cloudflare, Deno, Supabase, URL modules, or adapters.

Automated dependency updates still require the full adapter/conformance and
security gates. Compatibility dates, Deno locks, migration checksums, and
generated Cloudflare Env declarations change only in reviewed commits.

## CI actions and permissions

Workflow actions are pinned to full commit SHAs with a human-readable major tag
comment. Workflows declare least privileges. Pull requests have no deployment
secrets; forks cannot produce trusted release provenance. CodeQL runs on pull
requests, main, and a weekly schedule. Gitleaks scans full history.

The security job also runs production dependency audit, ESLint, Prettier,
dependency policy, AST import boundaries, and the 1,000-line authored-source
hard limit. Generated Cloudflare types are regenerated and must leave a clean
diff. Generated files are not exempt from human review.

## Artifacts

`tools/release/build-review-bundle.mjs` stages package contents in a temporary
directory, removes `workspace:*`, and produces deterministic archives. It never
invokes npm publish, a provider CLI deploy, Git tagging, or GitHub Release APIs.
The protocol bundle derives JSON Schemas from the built Zod schemas. The Control
OpenAPI document is version-checked before packaging.

Syft generates CycloneDX JSON with an exact tool version. The finalizer records
source commit/ref/dirty state, file sizes, SHA-256/SHA-512, package/protocol
version, channel, and explicit non-deployment flags. GitHub's OIDC-backed
artifact attestation signs every SHA-256 subject. The workflow artifact remains
a review bundle until an operator separately approves a Release.

Consumers verify both checksum files and GitHub provenance, then pin immutable
Release URLs and lockfile integrity. Any changed content under an existing tag
is rejected. Releases include source/license, schemas, OpenAPI, declarations,
SBOM, checksums, provenance, migration notes, and platform capability evidence.

## Build reproducibility

Archives normalize package structure through the pinned pnpm packer and use only
built declarations/JavaScript, fixed manifests, README, and MIT license. CI
records the Git commit timestamp in the release manifest. Rebuilding the same
commit and lockfile should reproduce package digests; a mismatch blocks release
and is investigated rather than overwritten.

Provider deployments and OCI images, when approved, are tied to the same commit
and artifact digest. A successful build does not prove a deployed resource or
real-environment acceptance.
