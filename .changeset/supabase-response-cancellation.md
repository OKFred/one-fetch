---
---

Stop Supabase response bodies promptly when cancellation, timeout or the 20 MiB
limit is detected. Downstream completion no longer waits for the upstream
source's asynchronous cancellation. Finalize the existing partial/cancelled/
timeout report exactly once, ignore late reads and detach completed listeners.
Pending cleanup remains registered with the runtime; its completion does not
imply a verified upstream network disconnect. Hosted revalidation is still
required. No protocol, migration, dependency or other adapter changes.
