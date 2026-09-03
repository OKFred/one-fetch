# Adapter support matrix

This is the intended `0.1 Preview` boundary. The live
`GET /api/v1/capabilities` response is authoritative for a deployment and xPanel
must use it instead of assuming this table is current.

| Capability                             | Node 24.20+                                        | Cloudflare Workers             | Supabase Edge Functions      |
| -------------------------------------- | -------------------------------------------------- | ------------------------------ | ---------------------------- |
| HTTP Fetch and streaming response      | Preview                                            | Preview                        | Preview                      |
| Ordered protocol headers               | Exact until Node network rules apply               | Vendor may normalize/merge     | Vendor may normalize/merge   |
| Repeated target `Set-Cookie` metadata  | Yes                                                | Yes where runtime exposes it   | Yes where runtime exposes it |
| Target `Server-Timing`                 | Yes                                                | Yes                            | Yes                          |
| DNS/TCP/TLS phase timing               | Best available; phases can be unavailable on reuse | Unavailable                    | Unavailable                  |
| Explicit redirects with per-hop policy | Preview                                            | Preview                        | Preview                      |
| HTTP/HTTPS/SOCKS proxy                 | Unsupported in Preview pending approved-IP pinning | Unsupported                    | Unsupported                  |
| Custom CA/client certificate           | Node-only adapter option                           | Unsupported                    | Unsupported                  |
| WebSocket tunnel                       | Experimental; capability-gated                     | Experimental; capability-gated | Unsupported                  |
| Raw TCP/TLS tunnel                     | Experimental; capability-gated                     | Unsupported in Preview         | Unsupported in Preview       |
| Strong DNS target pinning              | All A/AAAA checked, selected IP pinned             | Platform-constrained           | Platform-constrained         |
| Durable storage                        | SQLite Worker Thread                               | D1 + Durable Objects           | PostgreSQL                   |
| Automated backup Control endpoint      | Not yet available                                  | Not yet available              | Not yet available            |

“Platform-constrained” means the adapter applies URL, hostname, resolved-data
available to it, recursion, and redirect checks but cannot prove the same socket
address pinning as Node. It must disclose that downgrade in capabilities.

Provider and runtime layers can add, remove, rewrite, or merge headers such as
forwarding identifiers, compression negotiation, tracing IDs, and server names.
These are not user-editable target headers. xPanel and the administration site
must show each adapter's `headerMutations` notices before execution.

Capabilities include the adapter version, configuration version and
`configUpdatedAt`. xPanel should display all three so users can tell whether an
administrator's policy or runtime configuration has changed since a request was
last run.
