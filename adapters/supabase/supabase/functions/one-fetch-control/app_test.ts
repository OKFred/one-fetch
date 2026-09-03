import { createControlHandler } from "./handler.ts";
import type { Database } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const environment: SupabaseEnvironment = {
  instanceId: "00000000-0000-4000-8000-000000000001",
  bootstrapSecret: "b".repeat(32),
  pepper: "p".repeat(32),
  auditSigningPrivateKey: "unused",
  auditKeyId: "test",
  supabaseUrl: "https://example.supabase.co",
  serviceRoleKey: "test-service-role",
  controlBaseUrl: "https://example.supabase.co/functions/v1/one-fetch-control",
  gatewayBaseUrl: "https://example.supabase.co/functions/v1/one-fetch-gateway",
  allowedAdminOrigins: ["https://admin.example"],
  allowedClientOrigins: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  buildVersion: "test",
};

Deno.test(
  "Control handler strips the function prefix and returns validated capabilities",
  async () => {
    const database: Database = {
      rpc: <T>(name: string) => {
        assert(name === "of_get_active_config", `unexpected RPC ${name}`);
        return Promise.resolve({
          instanceId: environment.instanceId,
          initialized: true,
          configVersion: "20260904T000000.000Z-test",
          updatedAt: "2026-09-04T00:00:00.000Z",
        } as T);
      },
    };
    const handler = createControlHandler(environment, database);
    const response = await handler(
      new Request(
        "https://example.supabase.co/functions/v1/one-fetch-control/api/v1/capabilities",
        {
          headers: {
            origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        },
      ),
    );
    const body = (await response.json()) as {
      provider?: string;
      protocolVersion?: number;
      transports?: { websocket?: { state?: string } };
    };
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(body.provider === "supabase", "provider must be supabase");
    assert(body.protocolVersion === 1, "protocol version must be 1");
    assert(
      body.transports?.websocket?.state === "unsupported",
      "an unimplemented tunnel must not be advertised",
    );
    assert(
      response.headers.get("access-control-allow-origin") ===
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "CORS origin missing",
    );
  },
);

Deno.test(
  "A target OPTIONS request is not mistaken for a browser preflight",
  async () => {
    const database: Database = {
      rpc: <T>() => Promise.resolve({ initialized: false } as T),
    };
    const handler = createControlHandler(environment, database);
    const response = await handler(
      new Request(
        "https://example.supabase.co/functions/v1/one-fetch-control/api/v1/unknown",
        { method: "OPTIONS", headers: { origin: "https://admin.example" } },
      ),
    );
    assert(
      response.status === 404,
      `expected route response, got ${response.status}`,
    );
  },
);

Deno.test("Execution reports use an Authorization bearer token", async () => {
  const calls: string[] = [];
  const database: Database = {
    rpc: <T>(name: string) => {
      calls.push(name);
      if (name === "of_authenticate_execution") {
        return Promise.resolve({
          tokenId: "00000000-0000-4000-8000-000000000002",
          name: "test",
          scopes: { transports: ["http"] },
          quotas: {},
        } as T);
      }
      if (name === "of_get_execution_report") {
        return Promise.resolve({
          schemaVersion: 1,
          reportId: "00000000-0000-4000-8000-000000000003",
          requestId: "request-1",
          outcome: "completed",
          source: "target",
          status: 200,
          responseBytes: 0,
          bodyComplete: true,
          timing: { phases: [], serverTiming: [] },
          finishedAt: "2026-09-04T00:00:00.000Z",
          auditState: "recorded",
        } as T);
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  const handler = createControlHandler(environment, database);
  const reportId = "00000000-0000-4000-8000-000000000003";
  const response = await handler(
    new Request(`${environment.controlBaseUrl}/api/v1/reports/${reportId}`, {
      headers: {
        authorization: "Bearer ofe_test-token",
        origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    }),
  );
  assert(response.status === 200, `expected 200, got ${response.status}`);
  assert(
    response.headers.get("access-control-allow-origin") ===
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "report CORS did not allow the configured extension",
  );
  assert(
    calls.join(",") === "of_authenticate_execution,of_get_execution_report",
    `unexpected RPC sequence ${calls.join(",")}`,
  );
});

Deno.test("Configuration uses the canonical flattened shape", async () => {
  const database: Database = {
    rpc: <T>(name: string) => {
      if (name === "of_authenticate_access") {
        return Promise.resolve({
          adminId: "00000000-0000-4000-8000-000000000010",
          sessionId: "00000000-0000-4000-8000-000000000011",
          familyId: "00000000-0000-4000-8000-000000000012",
        } as T);
      }
      if (name === "of_get_active_config") {
        return Promise.resolve({
          initialized: true,
          revision: 0,
          version: "20260904T000000.000Z-test",
          updatedAt: "2026-09-04T00:00:00.000Z",
          config: {
            gatewayPaused: false,
            policy: {
              schemaVersion: 1,
              mode: "allowlist",
              revision: 0,
              rules: [],
            },
            bodyInspectionBytes: 1_048_576,
            audit: {
              executionRetentionDays: 30,
              securityRetentionDays: 180,
              sealRetentionDays: 400,
            },
          },
        } as T);
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  const response = await createControlHandler(
    environment,
    database,
  )(
    new Request(`${environment.controlBaseUrl}/api/v1/config`, {
      headers: { authorization: "Bearer ofa_test-token" },
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert(response.status === 200, `expected 200, got ${response.status}`);
  assert(body.controlGatewayPairId === environment.instanceId, "pair ID lost");
  assert(
    "policy" in body && !("config" in body),
    "config shape is not canonical",
  );
});

Deno.test("Unimplemented management capabilities are explicit", async () => {
  const database: Database = {
    rpc: () => Promise.reject(new Error("unexpected database access")),
  };
  const response = await createControlHandler(
    environment,
    database,
  )(new Request(`${environment.controlBaseUrl}/api/v1/alerts`));
  const body = (await response.json()) as { error?: { code?: string } };
  assert(response.status === 501, `expected 501, got ${response.status}`);
  assert(body.error?.code === "unsupported", "missing unsupported marker");
});
