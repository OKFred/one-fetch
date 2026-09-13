---
"@one-fetch/adapter-node": patch
---

Sign early execution-token denials with the request binding and actual configuration version, so revoked or unknown tokens produce a Relay error rather than an apparent intermediary response. Authentication and configuration failures still fail closed; absent request bindings or unavailable configuration never receive invented metadata.
