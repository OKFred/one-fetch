import {
  decodeResponseMetadata,
  encodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  ONE_FETCH_TOKEN_HEADER,
} from "@one-fetch/protocol";

import { bytesToBase64Url } from "../_shared/crypto.ts";
import type { Database } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { createGatewayHandler } from "./handler.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("A mismatched storage instance fails before target work", async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("missing private key");
  const environment = {
    instanceId: "00000000-0000-4000-8000-000000000001",
    bootstrapSecret: "b".repeat(32),
    pepper: "p".repeat(32),
    auditSigningPrivateKey: bytesToBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    ),
    auditKeyId: "instance-pairing-test",
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-role-test",
    controlBaseUrl:
      "https://project.supabase.co/functions/v1/one-fetch-control",
    gatewayBaseUrl:
      "https://project.supabase.co/functions/v1/one-fetch-gateway",
    allowedAdminOrigins: [],
    allowedClientOrigins: [],
    buildVersion: "test",
  } satisfies SupabaseEnvironment;
  const calls: string[] = [];
  const database: Database = {
    rpc: <T>(name: string) => {
      calls.push(name);
      if (name === "of_authenticate_execution") {
        return Promise.resolve({
          tokenId: "00000000-0000-4000-8000-000000000002",
          name: "test",
          scopes: {
            transports: ["http"],
            origins: ["https://api.example"],
            ports: [],
          },
          quotas: {
            requestsPerMinute: 60,
            burst: 10,
            concurrentHttp: 4,
            concurrentTunnels: 2,
            bytesPerDay: 1_073_741_824,
          },
        } as T);
      }
      if (name === "of_get_active_config") {
        return Promise.resolve({
          instanceId: "00000000-0000-4000-8000-000000000099",
          initialized: true,
          version: "config-test",
          gatewayPaused: false,
          auditDegraded: false,
          config: {
            gatewayPaused: false,
            policy: {
              schemaVersion: 1,
              mode: "blocklist",
              revision: 0,
              rules: [],
            },
            bodyInspectionBytes: 1_048_576,
          },
        } as T);
      }
      return Promise.reject(new Error(`unexpected RPC ${name}`));
    },
  };
  const encoded = encodeRequestMetadata({
    protocolVersion: 1,
    requestId: "request-instance-pairing",
    nonce: "0123456789abcdef0123456789abcdef",
    transport: "http",
    targetOrigin: "https://api.example",
    targetHeaders: [],
    fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
    body: { sizeBytes: 0 },
    hop: 0,
  });
  const response = await createGatewayHandler(
    environment,
    database,
  )(
    new Request(`${environment.gatewayBaseUrl}/resource`, {
      headers: {
        [ONE_FETCH_REQUEST_HEADER]: encoded,
        [ONE_FETCH_TOKEN_HEADER]: "ofe_test-token",
      },
    }),
  );
  const signed = decodeResponseMetadata(
    response.headers.get(ONE_FETCH_RESPONSE_HEADER) ?? "",
  );
  assert(response.status === 503, `expected 503, got ${response.status}`);
  assert(
    signed.outcome === "relay-error" &&
      signed.error?.code === "storage_unavailable",
    "instance mismatch was not a signed relay error",
  );
  assert(
    calls.join(",") === "of_authenticate_execution,of_get_active_config",
    `unexpected RPC sequence ${calls.join(",")}`,
  );
});
