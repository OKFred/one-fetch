import {
  decodeResponseMetadata,
  ONE_FETCH_LIMITS_V1,
  ONE_FETCH_RESPONSE_HEADER,
} from "@one-fetch/protocol";

import type { Database } from "../_shared/database.ts";
import { bytesToBase64Url } from "../_shared/crypto.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import type { OneFetchRequestMetaV1 } from "../_shared/protocol-types.ts";
import { executeHttp } from "./executor.ts";
import type { ActiveConfig, GatewayContext } from "./foundation.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function environment(): Promise<SupabaseEnvironment> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("missing private key");
  return {
    instanceId: "00000000-0000-4000-8000-000000000001",
    bootstrapSecret: "b".repeat(32),
    pepper: "p".repeat(32),
    auditSigningPrivateKey: bytesToBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    ),
    auditKeyId: "terminal-test",
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

function metadata(
  overrides: Partial<OneFetchRequestMetaV1> = {},
): OneFetchRequestMetaV1 {
  return {
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    nonce: crypto.randomUUID().replaceAll("-", ""),
    transport: "http",
    targetOrigin: "https://api.example",
    targetHeaders: [],
    fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
    body: { sizeBytes: 0 },
    hop: 0,
    ...overrides,
  };
}

const config: ActiveConfig = {
  initialized: true,
  version: "config-terminal-test",
  config: {
    gatewayPaused: false,
    policy: { schemaVersion: 1, mode: "blocklist", revision: 0, rules: [] },
    bodyInspectionBytes: ONE_FETCH_LIMITS_V1.inspectableBodyBytes,
  },
};

async function harness(requestMetadata: OneFetchRequestMetaV1) {
  const reports: Array<Record<string, unknown>> = [];
  const database: Database = {
    rpc: <T>(name: string, parameters: Record<string, unknown> = {}) => {
      if (name === "of_append_audit") {
        return Promise.resolve(crypto.randomUUID() as T);
      }
      if (name === "of_acquire_execution") {
        return Promise.resolve({
          allowed: true,
          leaseId: crypto.randomUUID(),
        } as T);
      }
      if (name === "of_reconcile_execution_request") {
        return Promise.resolve({ allowed: true } as T);
      }
      if (name === "of_finalize_execution") {
        reports.push(parameters.p_report as Record<string, unknown>);
        return Promise.resolve({
          status: "finalized",
          auditState: "recorded",
        } as T);
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  const context: GatewayContext = {
    environment: await environment(),
    database,
    token: "ofe_terminal_test_token",
    principal: {
      tokenId: "00000000-0000-4000-8000-000000000002",
      name: "terminal-test",
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
    },
    metadata: requestMetadata,
    configVersion: "config-terminal-test",
    startedAt: performance.now(),
    requestMethod: "GET",
    targetPathAndQuery: "/terminal",
  };
  return { context, reports };
}

function assertTerminalError(
  response: Response,
  reports: Array<Record<string, unknown>>,
  expectedCode: string,
): void {
  const signed = decodeResponseMetadata(
    response.headers.get(ONE_FETCH_RESPONSE_HEADER) ?? "",
  );
  assert(signed.outcome === "relay-error", "response was not a relay error");
  assert(signed.error?.code === expectedCode, "response error code changed");
  assert(typeof signed.reportId === "string", "response omitted report ID");
  assert(reports.length === 1, "terminal path did not finalize exactly once");
  assert(reports[0]?.reportId === signed.reportId, "report ID did not match");
  const problem = reports[0]?.problem as { code?: string } | undefined;
  assert(problem?.code === expectedCode, "report omitted terminal problem");
}

Deno.test("Upload metadata failures finalize the acquired lease", async () => {
  const requestMetadata = metadata({ body: { sizeBytes: 1 } });
  const { context, reports } = await harness(requestMetadata);
  context.requestMethod = "POST";
  const response = await executeHttp(
    new Request(`${context.environment.gatewayBaseUrl}/terminal`, {
      method: "POST",
    }),
    context,
    config,
  );
  assert(response.status === 400, `expected 400, got ${response.status}`);
  assertTerminalError(response, reports, "invalid_metadata");
});

Deno.test("Upload timeout finalizes the acquired lease", async () => {
  const requestMetadata = metadata({
    fetchOptions: { redirect: "manual", timeoutMs: 20 },
    body: {},
  });
  const { context, reports } = await harness(requestMetadata);
  context.requestMethod = "POST";
  const response = await executeHttp(
    new Request(`${context.environment.gatewayBaseUrl}/terminal`, {
      method: "POST",
      body: new ReadableStream<Uint8Array>({ start() {} }),
    }),
    context,
    config,
  );
  assert(response.status === 504, `expected 504, got ${response.status}`);
  assertTerminalError(response, reports, "timeout");
});

Deno.test(
  "Client upload cancellation finalizes the acquired lease",
  async () => {
    const { context, reports } = await harness(metadata({ body: {} }));
    context.requestMethod = "POST";
    const controller = new AbortController();
    const pending = executeHttp(
      new Request(`${context.environment.gatewayBaseUrl}/terminal`, {
        method: "POST",
        body: new ReadableStream<Uint8Array>({ start() {} }),
        signal: controller.signal,
      }),
      context,
      config,
    );
    controller.abort(new DOMException("test cancellation", "AbortError"));
    const response = await pending;
    assert(response.status === 400, `expected 400, got ${response.status}`);
    assertTerminalError(response, reports, "cancelled");
  },
);

Deno.test(
  "Upstream connection failures finalize the acquired lease",
  async () => {
    const { context, reports } = await harness(metadata());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("synthetic outage"));
    try {
      const response = await executeHttp(
        new Request(`${context.environment.gatewayBaseUrl}/terminal`),
        context,
        config,
      );
      assert(response.status === 502, `expected 502, got ${response.status}`);
      assertTerminalError(response, reports, "upstream_network");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test("Redirect rejection finalizes the acquired lease", async () => {
  const requestMetadata = metadata({
    fetchOptions: { redirect: "error", timeoutMs: 60_000 },
  });
  const { context, reports } = await harness(requestMetadata);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "https://api.example/next" },
      }),
    );
  try {
    const response = await executeHttp(
      new Request(`${context.environment.gatewayBaseUrl}/terminal`),
      context,
      config,
    );
    assert(response.status === 400, `expected 400, got ${response.status}`);
    assertTerminalError(response, reports, "redirect_disallowed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test(
  "Declared oversized target responses finalize the lease",
  async () => {
    const { context, reports } = await harness(metadata());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(null, {
          headers: {
            "content-length": String(ONE_FETCH_LIMITS_V1.responseBodyBytes + 1),
          },
        }),
      );
    try {
      const response = await executeHttp(
        new Request(`${context.environment.gatewayBaseUrl}/terminal`),
        context,
        config,
      );
      assert(response.status === 413, `expected 413, got ${response.status}`);
      assertTerminalError(response, reports, "response_too_large");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "Oversized target metadata finalizes the acquired lease",
  async () => {
    const { context, reports } = await harness(metadata());
    const originalFetch = globalThis.fetch;
    const headers = new Headers();
    for (let index = 0; index < 64; index += 1) {
      headers.set(`x-large-${index}`, "x".repeat(1_000));
    }
    globalThis.fetch = () => Promise.resolve(new Response(null, { headers }));
    try {
      const response = await executeHttp(
        new Request(`${context.environment.gatewayBaseUrl}/terminal`),
        context,
        config,
      );
      assert(response.status === 413, `expected 413, got ${response.status}`);
      assertTerminalError(response, reports, "response_metadata_too_large");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
