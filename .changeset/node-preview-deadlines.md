---
---

Fix the Node Preview Gateway's server-side deadline classification: a deadline
before target headers now returns a signed `timeout` / HTTP 504 result, while a
deadline during streaming produces an incomplete `timeout` execution report and
audit event. Preserve the first cancellation reason and stop backpressure waits
when execution is aborted. No protocol, migration, or cloud adapter changes.
