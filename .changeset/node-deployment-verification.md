---
"@one-fetch/adapter-node": patch
---

Make deployment verification fail closed on missing databases, incomplete or changed migration ledgers, modified SQL artifacts and mismatched Control instance identity. Offline checks now return `offline-verified` and cannot be mistaken for running-service acceptance. Control checks are bounded and reject redirects.
