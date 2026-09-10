import {
  decodeResponseMetadata,
  encodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  ONE_FETCH_TOKEN_HEADER,
} from "@one-fetch/protocol";
import { verifySignedResponseMetadata } from "@one-fetch/core";

import { bytesToBase64Url } from "../_shared/crypto.ts";
import type { Database } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { createGatewayTestHandler as createGatewayHandler } from "./test-support.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function environment(): Promise<SupabaseEnvironment> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const privateKey = "privateKey" in pair ? pair.privateKey : pair;
  return {
    instanceId: "00000000-0000-4000-8000-000000000001",
    bootstrapSecret: "b".repeat(32),
    pepper: "p".repeat(32),
    auditSigningPrivateKey: bytesToBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey)),
    ),
    auditKeyId: "test",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-role",
    controlBaseUrl:
      "https://example.supabase.co/functions/v1/one-fetch-control",
    gatewayBaseUrl:
      "https://example.supabase.co/functions/v1/one-fetch-gateway",
    allowedAdminOrigins: [],
    allowedClientOrigins: [
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
    buildVersion: "test",
  };
}

function encodedRequest(
  path = "/v1/users?include=roles",
  targetHeaders = [{ name: "Accept", value: "application/json" }],
) {
  return {
    path,
    encoded: encodeRequestMetadata({
      protocolVersion: 1,
      requestId: "request-1",
      nonce: "0123456789abcdef0123456789abcdef",
      transport: "http",
      targetOrigin: "https://api.example",
      targetHeaders,
      fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      body: { sizeBytes: 0 },
      hop: 0,
    }),
  };
}

function executionPrincipal() {
  return {
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
  };
}

Deno.test(
  "Unauthorized errors are signed with the supplied execution token",
  async () => {
    const env = await environment();
    const token = "ofe_test-token";
    const database: Database = {
      rpc: <T>(name: string) =>
        Promise.resolve(
          (name === "of_authenticate_execution"
            ? null
            : { initialized: true, version: "config-test" }) as T,
        ),
    };
    const metadata = encodedRequest();
    const response = await createGatewayHandler(
      env,
      database,
    )(
      new Request(`${env.gatewayBaseUrl}${metadata.path}`, {
        headers: {
          [ONE_FETCH_REQUEST_HEADER]: metadata.encoded,
          [ONE_FETCH_TOKEN_HEADER]: token,
        },
      }),
    );
    const signed = decodeResponseMetadata(
      response.headers.get(ONE_FETCH_RESPONSE_HEADER) ?? "",
    );
    assert(response.status === 401, `expected 401, got ${response.status}`);
    assert(
      signed.outcome === "relay-error" && signed.error?.code === "unauthorized",
      "wrong relay error",
    );
    assert(
      await verifySignedResponseMetadata(signed, {
        token,
        requestId: "request-1",
        nonce: "0123456789abcdef0123456789abcdef",
      }),
      "response signature did not verify",
    );
  },
);

Deno.test(
  "Authentication storage failures remain distinguishable",
  async () => {
    const env = await environment();
    const token = "ofe_test-token";
    const database: Database = {
      rpc: () => Promise.reject(new Error("database unavailable")),
    };
    const metadata = encodedRequest();
    const response = await createGatewayHandler(
      env,
      database,
    )(
      new Request(`${env.gatewayBaseUrl}${metadata.path}`, {
        headers: {
          [ONE_FETCH_REQUEST_HEADER]: metadata.encoded,
          [ONE_FETCH_TOKEN_HEADER]: token,
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
      "storage outage was masked as invalid credentials",
    );
  },
);

Deno.test(
  "Empty default allowlist denies arbitrary paths and audits the original path",
  async () => {
    const env = await environment();
    const auditEvents: Array<Record<string, unknown>> = [];
    const database: Database = {
      rpc: <T>(name: string, parameters: Record<string, unknown> = {}) => {
        if (name === "of_authenticate_execution") {
          return Promise.resolve(executionPrincipal() as T);
        }
        if (name === "of_get_active_config") {
          return Promise.resolve({
            instanceId: env.instanceId,
            initialized: true,
            version: "config-test",
            config: {
              gatewayPaused: false,
              policy: {
                schemaVersion: 1,
                mode: "allowlist",
                revision: 0,
                rules: [],
              },
              bodyInspectionBytes: 1_048_576,
            },
          } as T);
        }
        if (name === "of_append_audit") {
          auditEvents.push(parameters.p_event as Record<string, unknown>);
          return Promise.resolve(crypto.randomUUID() as T);
        }
        if (name === "of_acquire_execution") {
          return Promise.resolve({
            allowed: true,
            leaseId: "00000000-0000-4000-8000-000000000004",
          } as T);
        }
        if (name === "of_reconcile_execution_request") {
          return Promise.resolve({ allowed: true } as T);
        }
        if (name === "of_finalize_execution") {
          return Promise.resolve({
            status: "finalized",
            auditState: "recorded",
          } as T);
        }
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const metadata = encodedRequest("/v1/users?include=roles");
    const response = await createGatewayHandler(
      env,
      database,
    )(
      new Request(`${env.gatewayBaseUrl}${metadata.path}`, {
        headers: {
          [ONE_FETCH_REQUEST_HEADER]: metadata.encoded,
          [ONE_FETCH_TOKEN_HEADER]: "ofe_test",
        },
      }),
    );
    assert(response.status === 403, `expected 403, got ${response.status}`);
    const received = auditEvents[0] as
      | { request?: { path?: string; query?: string[][] } }
      | undefined;
    assert(
      received?.request?.path === "/v1/users",
      "audit did not retain the target path",
    );
    assert(
      received.request.query?.[0]?.[0] === "include",
      "audit did not retain query names",
    );
  },
);

Deno.test(
  "A streamed target error stays a target result and finalizes a canonical report",
  async () => {
    const env = await environment();
    let finishReport!: (value: Record<string, unknown>) => void;
    const reportPromise = new Promise<Record<string, unknown>>((resolve) => {
      finishReport = resolve;
    });
    const database: Database = {
      rpc: <T>(name: string, parameters: Record<string, unknown> = {}) => {
        if (name === "of_authenticate_execution") {
          return Promise.resolve(executionPrincipal() as T);
        }
        if (name === "of_get_active_config") {
          return Promise.resolve({
            instanceId: env.instanceId,
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
        if (name === "of_acquire_execution") {
          return Promise.resolve({
            allowed: true,
            leaseId: "00000000-0000-4000-8000-000000000004",
          } as T);
        }
        if (name === "of_reconcile_execution_request") {
          return Promise.resolve({ allowed: true } as T);
        }
        if (name === "of_finalize_execution") {
          finishReport(parameters.p_report as Record<string, unknown>);
          return Promise.resolve({
            status: "finalized",
            auditState: "recorded",
          } as T);
        }
        if (name === "of_append_audit") {
          return Promise.resolve(crypto.randomUUID() as T);
        }
        if (name === "of_release_execution") {
          return Promise.resolve(true as T);
        }
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const originalFetch = globalThis.fetch;
    const upstreamHeaders = new Headers({
      "content-type": "text/plain",
      "server-timing": "app;dur=12.5",
    });
    upstreamHeaders.append("set-cookie", "session=one; Path=/; HttpOnly");
    upstreamHeaders.append("set-cookie", "preference=two; Path=/");
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(new TextEncoder().encode("target unavailable"), {
          status: 503,
          headers: upstreamHeaders,
        }),
      );
    try {
      const metadata = encodedRequest("/status");
      const response = await createGatewayHandler(
        env,
        database,
      )(
        new Request(`${env.gatewayBaseUrl}${metadata.path}`, {
          headers: {
            [ONE_FETCH_REQUEST_HEADER]: metadata.encoded,
            [ONE_FETCH_TOKEN_HEADER]: "ofe_test",
          },
        }),
      );
      const signed = decodeResponseMetadata(
        response.headers.get(ONE_FETCH_RESPONSE_HEADER) ?? "",
      );
      assert(response.status === 503, "target status was not preserved");
      assert(signed.outcome === "target", "target 5xx became a relay error");
      assert(
        signed.target?.kind === "http" && !signed.target.bodyComplete,
        "streaming metadata must defer completion to the final report",
      );
      assert(
        signed.target?.kind === "http" && signed.target.setCookie.length === 2,
        "repeated Set-Cookie values were not preserved in metadata",
      );
      assert(
        !response.headers.has("set-cookie"),
        "target Set-Cookie escaped onto the Gateway origin",
      );
      assert(
        signed.timing.serverTiming[0]?.name === "app",
        "target Server-Timing was not preserved",
      );
      assert(
        (await response.text()) === "target unavailable",
        "target body was not preserved",
      );
      const report = await reportPromise;
      assert(report.outcome === "completed", "report did not complete");
      assert(report.status === 503, "report lost the target status");
      assert(report.schemaVersion === 1, "report schema version missing");
      assert(
        report.bodySha256 ===
          "f65b6754cdcae686e8c538b217fe397319d9b2ed5ffa9ecb96409174e2b138b0",
        "report lost the streamed response digest",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "Policy evaluates every duplicate protocol header before vendor merging",
  async () => {
    const env = await environment();
    const database: Database = {
      rpc: <T>(name: string) => {
        if (name === "of_authenticate_execution") {
          return Promise.resolve(executionPrincipal() as T);
        }
        if (name === "of_get_active_config") {
          return Promise.resolve({
            instanceId: env.instanceId,
            initialized: true,
            version: "config-test",
            config: {
              gatewayPaused: false,
              policy: {
                schemaVersion: 1,
                mode: "blocklist",
                revision: 0,
                rules: [
                  {
                    id: "deny-blocked-header",
                    name: "Deny a blocked duplicate header value",
                    enabled: true,
                    action: "deny",
                    match: {
                      headers: [
                        {
                          name: {
                            operator: "exact",
                            value: "x-one-fetch-test",
                          },
                          value: { operator: "exact", value: "blocked" },
                          presence: "present",
                        },
                      ],
                    },
                  },
                ],
              },
              bodyInspectionBytes: 1_048_576,
            },
          } as T);
        }
        if (name === "of_append_audit") {
          return Promise.resolve(crypto.randomUUID() as T);
        }
        if (name === "of_acquire_execution") {
          return Promise.resolve({
            allowed: true,
            leaseId: "00000000-0000-4000-8000-000000000004",
          } as T);
        }
        if (name === "of_reconcile_execution_request") {
          return Promise.resolve({ allowed: true } as T);
        }
        if (name === "of_finalize_execution") {
          return Promise.resolve({
            status: "finalized",
            auditState: "recorded",
          } as T);
        }
        throw new Error(`policy bypass reached unexpected RPC ${name}`);
      },
    };
    const metadata = encodedRequest("/headers", [
      { name: "X-One-Fetch-Test", value: "safe" },
      { name: "X-One-Fetch-Test", value: "blocked" },
    ]);
    const response = await createGatewayHandler(
      env,
      database,
    )(
      new Request(`${env.gatewayBaseUrl}${metadata.path}`, {
        headers: {
          [ONE_FETCH_REQUEST_HEADER]: metadata.encoded,
          [ONE_FETCH_TOKEN_HEADER]: "ofe_test",
        },
      }),
    );
    const signed = decodeResponseMetadata(
      response.headers.get(ONE_FETCH_RESPONSE_HEADER) ?? "",
    );
    assert(response.status === 403, `expected 403, got ${response.status}`);
    assert(
      signed.outcome === "relay-error" &&
        signed.error?.code === "target_not_allowed",
      "duplicate blocked value bypassed the system policy",
    );
  },
);
