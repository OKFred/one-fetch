# Changesets in one-fetch

Changesets record user-visible protocol, adapter, administration UI, security,
and operations changes. All workspace packages are private because one-fetch
does not publish to npm. Changesets update versions and release notes only;
they never publish packages, deploy adapters, create tags, or create Releases.

Use a patch changeset for compatible fixes, minor for additive protocol or
capability work, and major for a breaking protocol or stored-data change. A
capability change must name the affected adapters and its conformance evidence.

Preview releases use the root version and are promoted to `1.0.0` only after the
gates in `docs/release.md` pass in real Cloudflare, Supabase, and Node environments.
