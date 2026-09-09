import type { Database } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { SUPABASE_MIGRATION_HISTORY } from "../_shared/migration-manifest.generated.ts";
import { createControlHandler } from "./handler.ts";

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function controlTestEnvironment(): Promise<SupabaseEnvironment> {
  const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in keys)) throw new TypeError("Expected an Ed25519 pair");
  return {
    instanceId: "00000000-0000-4000-8000-000000000001",
    bootstrapSecret: "b".repeat(32),
    pepper: "p".repeat(32),
    auditSigningPrivateKey: base64Url(
      await crypto.subtle.exportKey("pkcs8", keys.privateKey),
    ),
    auditKeyId: "test",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-role",
    controlBaseUrl: "https://control.example",
    gatewayBaseUrl: "https://gateway.example",
    allowedAdminOrigins: [],
    allowedClientOrigins: [],
    buildVersion: "test",
  };
}

export function controlMigrationHistory(): Array<{
  version: string;
  checksum: string;
}> {
  return SUPABASE_MIGRATION_HISTORY.map(({ version, checksum }) => ({
    version,
    checksum,
  }));
}

export function createControlTestHandler(
  environment: SupabaseEnvironment,
  database: Database,
) {
  const compatibleDatabase: Database = {
    rpc: <T>(name: string, parameters?: Record<string, unknown>) =>
      name === "of_get_migration_integrity"
        ? Promise.resolve(controlMigrationHistory() as T)
        : database.rpc<T>(name, parameters),
  };
  return createControlHandler(environment, compatibleDatabase);
}
