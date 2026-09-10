import { authenticateExecution } from "../_shared/auth.ts";
import type { Database } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const environment = {
  pepper: "p".repeat(32),
} as SupabaseEnvironment;

function database(value: unknown): Database {
  return { rpc: <T>() => Promise.resolve(value as T) };
}

Deno.test(
  "Execution authentication rejects malformed database principals",
  async () => {
    for (const value of [
      { tokenId: crypto.randomUUID(), name: "bad", scopes: {}, quotas: {} },
      {
        tokenId: crypto.randomUUID(),
        name: "bad",
        scopes: { transports: ["http"], origins: ["*"], ports: [] },
        quotas: { requestsPerMinute: -1 },
      },
    ]) {
      let rejected = false;
      try {
        await authenticateExecution("ofe_test", database(value), environment);
      } catch {
        rejected = true;
      }
      assert(rejected, "malformed principal was accepted");
    }
  },
);

Deno.test(
  "Execution authentication validates and returns a complete principal",
  async () => {
    const tokenId = crypto.randomUUID();
    const principal = await authenticateExecution(
      "ofe_test",
      database({
        tokenId,
        name: "xPanel",
        scopes: { transports: ["http"], origins: ["*"], ports: [] },
        quotas: {
          requestsPerMinute: 60,
          burst: 10,
          concurrentHttp: 4,
          concurrentTunnels: 2,
          bytesPerDay: 1_073_741_824,
        },
        expiresAt: null,
      }),
      environment,
    );
    assert(principal?.tokenId === tokenId, "valid principal was not returned");
    assert(principal.expiresAt === undefined, "null expiry was not normalized");
  },
);

Deno.test(
  "Execution authentication accepts PostgreSQL timestamptz offsets",
  async () => {
    const expiresAt = "2026-09-10T04:24:16.866+00:00";
    const principal = await authenticateExecution(
      "ofe_test",
      database({
        tokenId: crypto.randomUUID(),
        name: "xPanel",
        scopes: { transports: ["http"], origins: ["*"], ports: [] },
        quotas: {
          requestsPerMinute: 60,
          burst: 10,
          concurrentHttp: 4,
          concurrentTunnels: 2,
          bytesPerDay: 1_073_741_824,
        },
        expiresAt,
      }),
      environment,
    );
    assert(
      principal?.expiresAt === expiresAt,
      "PostgreSQL timestamp offset was not preserved",
    );
  },
);
