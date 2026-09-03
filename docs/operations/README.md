# Operations index

The runbooks describe reviewable procedures; they do not authorize a cloud
deployment. Commands with resource creation, migration, secret, traffic, or
restore effects require an operator-selected account/project and a separate
approval.

- [Node](deploy-node.md)
- [Cloudflare Workers](deploy-cloudflare.md)
- [Supabase Edge Functions](deploy-supabase.md)
- [Backup, restore, and migration rehearsal](backup-restore.md)

Every production installation must use separate HTTPS Control and Gateway
origins, a restricted Admin origin, an empty initial allowlist, independently
generated secrets, provider log review, and an encrypted off-provider backup.

Before and after a change, record instance/adapter/config versions, health,
capabilities, audit status, schema migration level, and the exact immutable
source revision. A successful CLI exit alone is not deployment acceptance.
