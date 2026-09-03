import { OneFetchControlClient } from "@one-fetch/client";
import { runControlConformance } from "@one-fetch/conformance";

import { createAuditEvent } from "../_shared/audit.ts";
import type { Database } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { SUPABASE_MIGRATION_HISTORY } from "../_shared/migration-manifest.generated.ts";
import { createControlHandler } from "./handler.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const instanceId = "00000000-0000-4000-8000-000000000001";
const adminId = "00000000-0000-4000-8000-000000000010";
const sessionId = "00000000-0000-4000-8000-000000000011";

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function testEnvironment(): Promise<SupabaseEnvironment> {
  const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in keys)) throw new TypeError("Expected an Ed25519 pair");
  return {
    instanceId,
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
    allowedAdminOrigins: ["https://admin.example"],
    allowedClientOrigins: [
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
    buildVersion: "test",
  };
}

const environment = await testEnvironment();
const signedAudit = await createAuditEvent(
  {
    category: "system",
    action: "conformance.fixture",
    outcome: "success",
    severity: "info",
    actor: { type: "system" },
    correlation: {},
  },
  environment,
);
const { integrity: signedAuditIntegrity, ...signedAuditPayload } = signedAudit;
const migrations = SUPABASE_MIGRATION_HISTORY.map(({ version, checksum }) => ({
  version,
  checksum,
}));

const storedConfiguration = {
  instanceId,
  initialized: true,
  gatewayPaused: false,
  revision: 3,
  version: "20260904T000000.000Z-canonical",
  updatedAt: "2026-09-04T00:00:00.000Z",
  auditDegraded: false,
  config: {
    gatewayPaused: false,
    policy: {
      schemaVersion: 1,
      mode: "allowlist",
      revision: 2,
      rules: [],
    },
    bodyInspectionBytes: 1_048_576,
    audit: {
      executionRetentionDays: 30,
      securityRetentionDays: 180,
      sealRetentionDays: 400,
    },
  },
};

function conformanceDatabase(): Database {
  return {
    rpc: <T>(name: string) => {
      if (name === "of_get_active_config") {
        return Promise.resolve(storedConfiguration as T);
      }
      if (name === "of_get_control_runtime_state") {
        return Promise.resolve({
          instanceId,
          initialized: true,
          auditDegraded: false,
          migrations,
        } as T);
      }
      if (name === "of_get_instance_state") {
        return Promise.resolve({
          instanceId,
          initialized: true,
          gatewayPaused: false,
          configRevision: 3,
          configVersion: storedConfiguration.version,
          updatedAt: storedConfiguration.updatedAt,
          auditDegraded: false,
        } as T);
      }
      if (name === "of_authenticate_access") {
        return Promise.resolve({
          adminId,
          sessionId,
          familyId: "00000000-0000-4000-8000-000000000012",
        } as T);
      }
      if (name === "of_list_execution_tokens") {
        return Promise.resolve([] as T);
      }
      if (name === "of_list_audit") {
        return Promise.resolve([
          {
            sequence: 7,
            payload: signedAuditPayload,
            payloadHash: signedAuditIntegrity.payloadHash,
            signature: signedAuditIntegrity.signature,
            keyId: signedAuditIntegrity.keyId,
          },
        ] as T);
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
}

Deno.test(
  "Supabase Control satisfies the shared canonical conformance surface",
  async () => {
    const handler = createControlHandler(environment, conformanceDatabase());
    const localFetch: typeof globalThis.fetch = (input, init) =>
      handler(new Request(input, init));
    const client = new OneFetchControlClient({
      controlUrl: environment.controlBaseUrl,
      accessToken: "ofa_test-token",
      fetch: localFetch,
    });
    const report = await runControlConformance(client, {
      expectedInstanceId: instanceId,
      includeManagement: true,
    });
    assert(
      report.passed,
      report.results
        .filter(({ passed }) => !passed)
        .map(({ id, failures }) => `${id}: ${failures.join(", ")}`)
        .join("\n"),
    );
  },
);

Deno.test(
  "Canonical configuration writes require a quoted If-Match",
  async () => {
    const handler = createControlHandler(environment, conformanceDatabase());
    const response = await handler(
      new Request(
        `${environment.controlBaseUrl}/api/v1/config/gateway-paused`,
        {
          method: "PUT",
          headers: {
            authorization: "Bearer ofa_test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ schemaVersion: 1, paused: true }),
        },
      ),
    );
    const body = (await response.json()) as { error?: { code?: string } };
    assert(response.status === 428, `expected 428, got ${response.status}`);
    assert(
      body.error?.code === "precondition_required",
      "missing canonical precondition error",
    );
  },
);

Deno.test("Execution token lists use the canonical envelope", async () => {
  const response = await createControlHandler(
    environment,
    conformanceDatabase(),
  )(
    new Request(`${environment.controlBaseUrl}/api/v1/tokens/execution`, {
      headers: { authorization: "Bearer ofa_test-token" },
    }),
  );
  const body = (await response.json()) as {
    schemaVersion?: number;
    tokens?: unknown[];
  };
  assert(response.status === 200, `expected 200, got ${response.status}`);
  assert(body.schemaVersion === 1, "schema version missing");
  assert(Array.isArray(body.tokens), "tokens envelope missing");
});
