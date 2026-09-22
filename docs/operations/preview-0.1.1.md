# one-fetch 0.1.1 Preview candidate

This is an unreleased maintenance candidate, not a 1.0 promotion. Protocol V1
and the HTTP-only transport boundary remain unchanged. xPanel is not changed.
The published v0.1.0 artifacts and historical acceptance receipts are immutable.

## Included changes

- Supabase empty-install validation, original path/query binding, opt-in
  terminal-report watching, complete logical backup and isolated RPC recovery.
- Protected Supabase updates with deployment CAS and verified code rollback.
- Cloudflare rollback points use actually deployed versions. Update checkpoints
  preserve pause uncertainty and backup/rollback identifiers before schema or
  Worker changes; interrupted updates cannot be marked verified or resumed.
- Cloudflare helper mutations now share an account/identity-bound D1 CAS lock.
  Crashes retain ownership; takeover requires exact owner/revision and explicit
  stopped-helper confirmation. Older deployments require paused, backed-up
  adoption. This does not fence dashboard operations or older tools.
- Node signed early token denials, strict installed identity/migration checks,
  cooperative operation locks and packaged pause/resume/recovery acceptance.
- Node write-ahead intent/confirmation journals cover update, rollback and
  explicit resume. Strong process-termination regressions cover source and
  standalone helpers without automatic lock takeover or database restoration.
- Runtime version identity follows installed/bundled metadata rather than a
  hardcoded 0.1.0 value. Node health, capabilities and OpenAPI agree; Cloudflare
  OpenAPI follows the same build binding as health and capabilities.

## Candidate acceptance

The Node cross-version runner now exercises actual published 0.1.0 and clean
0.1.1 archives, including activation failure, explicit recovery and code
rollback. See [the repeatable procedure](node-cross-version-acceptance.md).
Exact tested commits and receipt hashes belong in dated evidence; passing this
runner does not replace final-commit CI or full platform acceptance.

The exact push-CI candidate `2329c1f` additionally passes eight actual Node
archive/OCI/installed, cross-version and helper-interruption runs. The latter
kill the deployment helper against running packaged services on AMD64 and
emulated ARM64, preserving orphan-lock evidence before explicit recovery.
See [CI candidate evidence](node-ci-candidate-2026-09-22.md); this is not final
Release provenance, a server-process crash or a power-loss guarantee.

Cloudflare candidate `b680b1b` passes a real temporary install/update workflow,
both full HTTP suites (17 executed passes plus one declared platform skip each),
signed audit preservation, separate D1 backup restoration and paused code
rollback. All temporary Workers, D1 databases and DO namespaces were removed.
See [the hosted evidence](cloudflare-candidate-2026-09-22.md). The two deployments
use the same candidate source with different build IDs; this is not published
cross-version or final-release artifact acceptance.

## Release gates still open

- Repeat the published 0.1.0 to candidate 0.1.1 Node rehearsal on the final
  release artifact, including retained credentials, policy and audit signatures.
- Repeat the now-verified CI packaged helper-interruption procedure on final
  Release artifacts. The gap between activation, restart and explicit resume
  remains operator-managed, not a full-lifecycle lease or power-loss guarantee.
- Final-commit three-platform acceptance, checksums and provenance verification.
- Repeat Cloudflare install/update/rollback/cleanup acceptance with the new
  D1 coordination integrated; earlier hosted receipts predate that change.
- Explicitly disclose Supabase provider stream-reset limitations and skipped
  probes; client report watching is not proof of upstream socket disconnect.

Existing September 13 evidence applies only to the exact older commits named
in those reports. It does not automatically validate this candidate. Do not
merge, tag or publish based on a package version bump alone.
