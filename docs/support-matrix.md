# Adapter support matrix

This is the intended `0.1 Preview` boundary. The live
`GET /api/v1/capabilities` response is authoritative for a deployment and xPanel
must use it instead of assuming this table is current.

| Capability                             | Node 24.20+                                        | Cloudflare Workers           | Supabase Edge Functions      |
| -------------------------------------- | -------------------------------------------------- | ---------------------------- | ---------------------------- |
| HTTP Fetch and streaming response      | Preview                                            | Preview                      | Preview                      |
| Ordered protocol headers               | Exact until Node network rules apply               | Vendor may normalize/merge   | Vendor may normalize/merge   |
| Repeated target `Set-Cookie` metadata  | Yes                                                | Yes where runtime exposes it | Yes where runtime exposes it |
| Target `Server-Timing`                 | Yes                                                | Yes                          | Yes                          |
| DNS/TCP/TLS phase timing               | Best available; phases can be unavailable on reuse | Unavailable                  | Unavailable                  |
| Explicit redirects with per-hop policy | Preview                                            | Preview                      | Preview                      |
| HTTP/HTTPS/SOCKS proxy                 | Unsupported in Preview pending approved-IP pinning | Unsupported                  | Unsupported                  |
| Custom CA/client certificate           | Node-only adapter option                           | Unsupported                  | Unsupported                  |
| WebSocket tunnel                       | Unsupported in 0.1 Preview                         | Unsupported in 0.1 Preview   | Unsupported in 0.1 Preview   |
| Raw TCP/TLS tunnel                     | Unsupported in 0.1 Preview                         | Unsupported in 0.1 Preview   | Unsupported in 0.1 Preview   |
| Strong DNS target pinning              | All A/AAAA checked, selected IP pinned             | Platform-constrained         | Platform-constrained         |
| Durable storage                        | SQLite Worker Thread                               | D1 + Durable Objects         | PostgreSQL                   |
| Automated backup Control endpoint      | Not yet available                                  | Not yet available            | Not yet available            |
| Alerts, Webhook, and audit export      | Explicit 501 unsupported                           | Explicit 501 unsupported     | Explicit 501 unsupported     |

“Platform-constrained” means the adapter applies URL, hostname, resolved-data
available to it, recursion, and redirect checks but cannot prove the same socket
address pinning as Node. It must disclose that downgrade in capabilities.

The development Supabase adapter requires an
[original-path binding](supabase-path-binding.md) negotiated through capabilities.
It restores repeated slashes and percent-escape spelling only after checking
the observed ingress path; unknown rewrites or missing bindings are rejected.
This is locally tested, with hosted revalidation pending. Published `v0.1.0`
artifacts do not contain the fix; see the
[hosted failure evidence](operations/supabase-revalidation-2026-09-12.md).

Provider and runtime layers can add, remove, rewrite, or merge headers such as
forwarding identifiers, compression negotiation, tracing IDs, and server names.
These are not user-editable target headers. xPanel and the administration site
must show each adapter's `headerMutations` notices before execution.

Capabilities include the adapter version, configuration version and
`configUpdatedAt`. xPanel should display all three so users can tell whether an
administrator's policy or runtime configuration has changed since a request was
last run.

The public feature-status endpoint describes unavailable management features;
calling one of those operations returns the same canonical HTTP 501
`feature_unsupported` response on every adapter. The administration site reads
that status first, disables the affected actions, and shows the adapter's
reason instead of treating an empty result as success.
