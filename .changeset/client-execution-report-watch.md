---
"@one-fetch/client": patch
---

Add opt-in, bounded execution report monitoring to interrupt hosted response
streams that do not propagate terminal errors. Watch only an explicitly trusted
Control URL and a nonce-verified target report handle; preserve request identity,
raw bytes and target classification. Missing or invalid reports fall back to the
local deadline. Expose typed incomplete-report errors and make consumer Stop
independent of asynchronous stream cleanup.
