---
"@one-fetch/adapter-node": patch
---

Serialize install, update, resume and rollback for each local installation root.
Reject stale pointers, wrong Control identity and migration/backup drift before
activation, and verify update/rollback targets before changing traffic state.
The cooperative local lock has no automatic stale takeover and is not a
distributed deployment lease or a complete cross-version upgrade acceptance.
