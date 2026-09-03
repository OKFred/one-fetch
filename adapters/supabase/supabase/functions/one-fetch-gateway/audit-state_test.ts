import type { Database } from "../_shared/database.ts";
import { bytesToBase64Url } from "../_shared/crypto.ts";
import { auditStateAfter } from "./execution-setup.ts";
import type { GatewayContext } from "./foundation.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("A failed pre-lease audit persists the degraded marker", async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("missing private key");
  const calls: string[] = [];
  const database: Database = {
    rpc: <T>(name: string) => {
      calls.push(name);
      if (name === "of_append_audit") {
        return Promise.reject(new Error("audit unavailable"));
      }
      if (name === "of_set_audit_degraded") {
        return Promise.resolve(true as T);
      }
      return Promise.reject(new Error(`unexpected RPC ${name}`));
    },
  };
  const context = {
    database,
    environment: {
      instanceId: "00000000-0000-4000-8000-000000000001",
      bootstrapSecret: "b".repeat(32),
      pepper: "p".repeat(32),
      auditSigningPrivateKey: bytesToBase64Url(
        new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
      ),
      auditKeyId: "audit-state-test",
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "service-role-test",
      controlBaseUrl:
        "https://project.supabase.co/functions/v1/one-fetch-control",
      gatewayBaseUrl:
        "https://project.supabase.co/functions/v1/one-fetch-gateway",
      allowedAdminOrigins: [],
      allowedClientOrigins: [],
      buildVersion: "test",
    },
    token: "ofe_test",
    principal: {
      tokenId: "00000000-0000-4000-8000-000000000002",
      name: "test",
      scopes: { transports: ["http"], origins: [], ports: [] },
      quotas: {
        requestsPerMinute: 60,
        burst: 10,
        concurrentHttp: 4,
        concurrentTunnels: 2,
        bytesPerDay: 1_073_741_824,
      },
    },
    metadata: {
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      nonce: crypto.randomUUID().replaceAll("-", ""),
      transport: "http",
      targetOrigin: "https://api.example",
      targetHeaders: [],
      fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      body: { sizeBytes: 0 },
      hop: 0,
    },
    configVersion: "test",
    startedAt: performance.now(),
    requestMethod: "GET",
    targetPathAndQuery: "/resource",
  } satisfies GatewayContext;

  const state = await auditStateAfter(
    context,
    "recorded",
    "execution.received",
    "success",
  );
  assert(state === "degraded", "audit failure was not surfaced");
  assert(
    calls.join(",") === "of_append_audit,of_set_audit_degraded",
    `unexpected RPC sequence ${calls.join(",")}`,
  );
});
