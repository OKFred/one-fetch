import type { Database } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { SUPABASE_MIGRATION_HISTORY } from "../_shared/migration-manifest.generated.ts";
import { createGatewayHandler } from "./handler.ts";

export function gatewayMigrationHistory(): Array<{
  version: string;
  checksum: string;
}> {
  return SUPABASE_MIGRATION_HISTORY.map(({ version, checksum }) => ({
    version,
    checksum,
  }));
}

export function createGatewayTestHandler(
  environment: SupabaseEnvironment,
  database: Database,
) {
  const compatibleDatabase: Database = {
    rpc: <T>(name: string, parameters?: Record<string, unknown>) =>
      name === "of_get_migration_integrity"
        ? Promise.resolve(gatewayMigrationHistory() as T)
        : database.rpc<T>(name, parameters),
  };
  return createGatewayHandler(environment, compatibleDatabase);
}
