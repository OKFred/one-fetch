import { createAuditEvent } from "../_shared/audit.ts";
import type { Database } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";

export async function appendAuthFailure(
  action: string,
  category: "account" | "auth" | "security",
  severity: "info" | "warning" | "error" | "critical",
  environment: SupabaseEnvironment,
  database: Database,
  adminId?: string,
): Promise<void> {
  const audit = await createAuditEvent(
    {
      category,
      action,
      outcome: "failure",
      severity,
      actor: adminId
        ? { type: "admin", actorId: adminId }
        : { type: "anonymous" },
      correlation: {},
    },
    environment,
  );
  await database.rpc("of_append_audit", { p_event: audit });
}
