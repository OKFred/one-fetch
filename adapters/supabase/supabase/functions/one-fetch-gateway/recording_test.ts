import { createDatabase, type Database } from "../_shared/database.ts";
import { bytesToBase64Url } from "../_shared/crypto.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import type { OneFetchTimingV1 } from "../_shared/protocol-types.ts";
import type { GatewayContext } from "./foundation.ts";
import { finalize } from "./recording.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function context(database: Database): Promise<GatewayContext> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const privateKey = "privateKey" in pair ? pair.privateKey : pair;
  const environment = {
    pepper: "p".repeat(32),
    auditSigningPrivateKey: bytesToBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey)),
    ),
    auditKeyId: "test-key",
  } as SupabaseEnvironment;
  return {
    environment,
    database,
    token: "ofe_test",
    principal: {
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
    },
    metadata: {
      protocolVersion: 1,
      requestId: "request-finalize",
      nonce: "0123456789abcdef0123456789abcdef",
      transport: "http",
      targetOrigin: "https://api.example",
      targetHeaders: [],
      fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      body: { sizeBytes: 0 },
      hop: 0,
    },
    configVersion: "config-test",
    startedAt: performance.now(),
    requestMethod: "GET",
    targetPathAndQuery: "/status",
  };
}

const timing: OneFetchTimingV1 = { phases: [], serverTiming: [] };

Deno.test(
  "Prior audit degradation is persisted by one atomic finalization",
  async () => {
    let finalization: Record<string, unknown> | undefined;
    const database: Database = {
      rpc: <T>(name: string, parameters: Record<string, unknown> = {}) => {
        if (name === "of_finalize_execution") {
          finalization = parameters;
          return Promise.resolve({
            status: "finalized",
            auditState: "degraded",
          } as T);
        }
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const result = await finalize(await context(database), {
      leaseId: crypto.randomUUID(),
      reportId: crypto.randomUUID(),
      targetStatus: 200,
      responseBytes: 12,
      outcome: "completed",
      source: "target",
      timing,
      downloadMs: 3,
      auditState: "degraded",
    });
    assert(
      finalization?.p_prior_audit_degraded === true,
      "prior audit degradation was not sent to the atomic finalizer",
    );
    assert(
      result.auditState === "degraded",
      "database audit state was not returned to the response path",
    );
  },
);

Deno.test(
  "A failed degraded finalization is not silently swallowed",
  async () => {
    const database: Database = {
      rpc: () => Promise.reject(new Error("storage unavailable")),
    };
    let rejected = false;
    try {
      await finalize(await context(database), {
        leaseId: crypto.randomUUID(),
        reportId: crypto.randomUUID(),
        targetStatus: 200,
        responseBytes: 0,
        outcome: "completed",
        source: "target",
        timing,
        downloadMs: 0,
        auditState: "recorded",
      });
    } catch {
      rejected = true;
    }
    assert(rejected, "terminal storage failure was reported as success");
  },
);

Deno.test(
  "An uncertain transport failure retries the exact finalization",
  async () => {
    const attempts: Record<string, unknown>[] = [];
    const database: Database = {
      rpc: <T>(name: string, parameters: Record<string, unknown> = {}) => {
        if (name !== "of_finalize_execution") {
          throw new Error(`unexpected RPC ${name}`);
        }
        attempts.push(structuredClone(parameters));
        if (attempts.length === 1) {
          return Promise.reject(new TypeError("connection reset after commit"));
        }
        return Promise.resolve({
          status: "already_finalized",
          auditState: "recorded",
        } as T);
      },
    };
    const result = await finalize(await context(database), {
      leaseId: crypto.randomUUID(),
      reportId: crypto.randomUUID(),
      targetStatus: 204,
      responseBytes: 0,
      outcome: "completed",
      source: "target",
      timing,
      downloadMs: 0,
      auditState: "recorded",
    });
    assert(
      attempts.length === 2,
      "uncertain finalization was not retried once",
    );
    assert(
      JSON.stringify(attempts[0]) === JSON.stringify(attempts[1]),
      "finalization retry changed its idempotency inputs",
    );
    assert(result.auditState === "recorded", "retry result was not accepted");
  },
);

for (const failure of ["database_transport", "database_timeout"] as const) {
  Deno.test(
    `The real database client retries ${failure} finalization once`,
    async () => {
      let attempts = 0;
      const bodies: string[] = [];
      const database = createDatabase(
        {
          supabaseUrl: "https://project.supabase.co",
          serviceRoleKey: "service-role-test",
          buildVersion: "0.1.0-test",
        } as SupabaseEnvironment,
        {
          timeoutMs: 5,
          fetch: async (_input, init) => {
            attempts += 1;
            bodies.push(typeof init?.body === "string" ? init.body : "");
            if (attempts === 1 && failure === "database_transport") {
              throw new TypeError("connection reset after commit");
            }
            if (attempts === 1) {
              await new Promise<never>((_resolve, reject) => {
                const signal = init?.signal;
                if (!signal) {
                  reject(new Error("missing database timeout signal"));
                  return;
                }
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
              });
            }
            return new Response(
              JSON.stringify({
                status: "already_finalized",
                auditState: "recorded",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        },
      );
      const result = await finalize(await context(database), {
        leaseId: crypto.randomUUID(),
        reportId: crypto.randomUUID(),
        targetStatus: 204,
        responseBytes: 0,
        outcome: "completed",
        source: "target",
        timing,
        downloadMs: 0,
        auditState: "recorded",
      });
      assert(attempts === 2, `${failure} was not retried exactly once`);
      assert(bodies[0] === bodies[1], `${failure} retry parameters changed`);
      assert(result.auditState === "recorded", "retry result was not accepted");
    },
  );
}
