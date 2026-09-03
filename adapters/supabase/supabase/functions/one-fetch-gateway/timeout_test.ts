import {
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  ONE_FETCH_TOKEN_HEADER,
  decodeResponseMetadata,
  encodeRequestMetadata,
} from "@one-fetch/protocol";

import type { Database } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { createGatewayHandler } from "./handler.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test(
  "Supabase rejects timeouts above its declared 60 second limit",
  async () => {
    const environment = {
      instanceId: "00000000-0000-4000-8000-000000000001",
      bootstrapSecret: "b".repeat(32),
      pepper: "p".repeat(32),
      auditSigningPrivateKey: "unused",
      auditKeyId: "test",
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "unused",
      gatewayBaseUrl:
        "https://project.supabase.co/functions/v1/one-fetch-gateway",
      controlBaseUrl:
        "https://project.supabase.co/functions/v1/one-fetch-control",
      allowedAdminOrigins: [],
      allowedClientOrigins: [],
      buildVersion: "test",
    } satisfies SupabaseEnvironment;
    const database: Database = {
      rpc: <T>(name: string) => {
        if (name === "of_authenticate_execution") {
          return Promise.resolve({
            tokenId: crypto.randomUUID(),
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
            expiresAt: null,
          } as T);
        }
        if (name === "of_get_active_config") {
          return Promise.resolve({
            instanceId: environment.instanceId,
            initialized: true,
            version: "config-test",
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
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const token = "ofe_test";
    const encoded = encodeRequestMetadata({
      protocolVersion: 1,
      requestId: "request-timeout",
      nonce: "0123456789abcdef0123456789abcdef",
      transport: "http",
      targetOrigin: "https://api.example",
      targetHeaders: [],
      fetchOptions: { redirect: "manual", timeoutMs: 60_001 },
      body: { sizeBytes: 0 },
      hop: 0,
    });
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      fetchCalls += 1;
      return Promise.reject(new Error("unexpected target fetch"));
    };
    try {
      const response = await createGatewayHandler(
        environment,
        database,
      )(
        new Request(`${environment.gatewayBaseUrl}/resource`, {
          headers: {
            [ONE_FETCH_REQUEST_HEADER]: encoded,
            [ONE_FETCH_TOKEN_HEADER]: token,
          },
        }),
      );
      const signed = decodeResponseMetadata(
        response.headers.get(ONE_FETCH_RESPONSE_HEADER) ?? "",
      );
      assert(
        response.status === 400,
        `expected 400, got ${response.status}: ${await response.clone().text()}`,
      );
      assert(
        signed.outcome === "relay-error" &&
          signed.error?.code === "unsupported_option",
        "timeout was not rejected as an unsupported option",
      );
      assert(fetchCalls === 0, "target fetch ran for an excessive timeout");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
