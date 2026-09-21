# one-fetch 0.1.1 Preview candidate

This is an unreleased maintenance candidate, not a 1.0 promotion. Protocol V1
and the HTTP-only transport boundary remain unchanged. xPanel is not changed.
The published v0.1.0 artifacts and historical acceptance receipts are immutable.

## Included changes

- Supabase empty-install validation, original path/query binding, opt-in
  terminal-report watching, complete logical backup and isolated RPC recovery.
- Protected Supabase updates with deployment CAS and verified code rollback.
- Node signed early token denials, strict installed identity/migration checks,
  cooperative operation locks and packaged pause/resume/recovery acceptance.
- Runtime version identity follows installed/bundled metadata rather than a
  hardcoded 0.1.0 value. Node health, capabilities and OpenAPI agree; Cloudflare
  OpenAPI follows the same build binding as health and capabilities.

## Candidate acceptance

The Node cross-version runner now exercises actual published 0.1.0 and clean
0.1.1 archives, including activation failure, explicit recovery and code
rollback. See [the repeatable procedure](node-cross-version-acceptance.md).
Exact tested commits and receipt hashes belong in dated evidence; passing this
runner does not replace final-commit CI or full platform acceptance.

## Release gates still open

- Repeat the published 0.1.0 to candidate 0.1.1 Node rehearsal on the final
  release artifact, including retained credentials, policy and audit signatures.
- Interrupted-update recovery and the gap between activation, restart and
  explicit resume; the current local operation lock is not a lifecycle lease.
- Final-commit three-platform acceptance, checksums and provenance verification.
- Explicitly disclose Supabase provider stream-reset limitations and skipped
  probes; client report watching is not proof of upstream socket disconnect.

Existing September 13 evidence applies only to the exact older commits named
in those reports. It does not automatically validate this candidate. Do not
merge, tag or publish based on a package version bump alone.
