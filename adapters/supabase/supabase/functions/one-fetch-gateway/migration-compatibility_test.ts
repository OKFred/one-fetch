import {
  decodeResponseMetadata,
  encodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  ONE_FETCH_TOKEN_HEADER,
} from "@one-fetch/protocol";

import { bytesToBase64Url } from "../_shared/crypto.ts";
import { type Database, DatabaseError } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { createGatewayHandler } from "./handler.ts";
import { gatewayMigrationHistory } from "./test-support.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function environment(): Promise<SupabaseEnvironment> {
  const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in keys)) throw new Error("missing private key");
  return {
    instanceId: "00000000-0000-4000-8000-000000000001",
    bootstrapSecret: "b".repeat(32),
    pepper: "p".repeat(32),
    auditSigningPrivateKey: bytesToBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
    ),
    auditKeyId: "migration-test",
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-role-test",
    controlBaseUrl:
      "https://project.supabase.co/functions/v1/one-fetch-control",
    gatewayBaseUrl:
      "https://project.supabase.co/functions/v1/one-fetch-gateway",
    allowedAdminOrigins: [],
    allowedClientOrigins: [],
    buildVersion: "0.1.0-test",
  };
}

function request(runtime: SupabaseEnvironment): Request {
  return new Request(`${runtime.gatewayBaseUrl}/compatibility`, {
    headers: {
      [ONE_FETCH_REQUEST_HEADER]: encodeRequestMetadata({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        nonce: crypto.randomUUID().replaceAll("-", ""),
        transport: "http",
        targetOrigin: "https://api.example",
        targetHeaders: [],
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
        body: { sizeBytes: 0 },
        hop: 0,
      }),
      [ONE_FETCH_TOKEN_HEADER]: `ofe_${"t".repeat(32)}`,
    },
  });
}

async function expectStorageFailure(
  runtime: SupabaseEnvironment,
  database: Database,
  calls: string[],
): Promise<void> {
  const response = await createGatewayHandler(
    runtime,
    database,
  )(request(runtime));
  const metadata = decodeResponseMetadata(
    response.headers.get(ONE_FETCH_RESPONSE_HEADER) ?? "",
  );
  assert(response.status === 503, `expected 503, got ${response.status}`);
  assert(metadata.outcome === "relay-error", "response was not a relay error");
  assert(
    metadata.error?.code === "storage_unavailable",
    "migration failure was not a storage error",
  );
  assert(
    calls.join(",") === "of_get_migration_integrity",
    `Gateway work ran before compatibility: ${calls.join(",")}`,
  );
}

Deno.test(
  "Missing, unknown, and changed migrations block the Gateway",
  async () => {
    const runtime = await environment();
    const compatible = gatewayMigrationHistory();
    const fixtures: unknown[] = [
      compatible.slice(0, -1),
      [...compatible, { version: "999999999999", checksum: "1".repeat(64) }],
      compatible.map((entry, index) =>
        index === 0 ? { ...entry, checksum: "2".repeat(64) } : entry,
      ),
    ];
    for (const fixture of fixtures) {
      const calls: string[] = [];
      const database: Database = {
        rpc: <T>(name: string) => {
          calls.push(name);
          return Promise.resolve(fixture as T);
        },
      };
      await expectStorageFailure(runtime, database, calls);
    }
  },
);

Deno.test(
  "Migration contract and database failures are signed 503 responses",
  async () => {
    const runtime = await environment();
    for (const result of [
      { migrations: [] },
      new DatabaseError(
        "migration storage unavailable",
        503,
        "database_transport",
      ),
    ]) {
      const calls: string[] = [];
      const database: Database = {
        rpc: <T>(name: string) => {
          calls.push(name);
          return result instanceof Error
            ? Promise.reject(result)
            : Promise.resolve(result as T);
        },
      };
      await expectStorageFailure(runtime, database, calls);
    }
  },
);

Deno.test("Gateway caches only a successful compatibility check", async () => {
  const runtime = await environment();
  let compatibilityChecks = 0;
  let authentications = 0;
  const database: Database = {
    rpc: <T>(name: string) => {
      if (name === "of_get_migration_integrity") {
        compatibilityChecks += 1;
        return Promise.resolve(gatewayMigrationHistory() as T);
      }
      if (name === "of_authenticate_execution") {
        authentications += 1;
        return Promise.resolve(null as T);
      }
      return Promise.reject(new Error(`unexpected RPC ${name}`));
    },
  };
  const handler = createGatewayHandler(runtime, database);
  assert(
    (await handler(request(runtime))).status === 401,
    "first auth changed",
  );
  assert(
    (await handler(request(runtime))).status === 401,
    "second auth changed",
  );
  assert(compatibilityChecks === 1, "compatibility result was not reused");
  assert(authentications === 2, "authentication was unexpectedly cached");
});
