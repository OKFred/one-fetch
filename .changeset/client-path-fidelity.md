---
---

Preserve leading repeated slashes and authority-shaped segments when the client
joins Gateway URLs and when Gateways, policy checks, and Node audit rebuild
target URLs. Previously, URL reference parsing could discard a path segment or
reinterpret it as a host. Keep initial target paths bound to the declared origin;
HTTP Location redirects retain their normal URL-reference semantics and checks.
Cover root/provider-prefix Gateway URLs, encoded and duplicate queries, policy
matching, and adapter boundaries. No wire version or published 0.1.0 artifact
changes; distribute the fix in a future reviewed patch.
