import { ActiveConfigSchema } from "./foundation.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test(
  "Active configuration accepts the complete PostgreSQL RPC shape",
  () => {
    const updatedAt = "2026-09-10T02:49:27.962277+00:00";
    const configuration = ActiveConfigSchema.parse({
      instanceId: crypto.randomUUID(),
      initialized: true,
      gatewayPaused: false,
      revision: 2,
      version: "20260910T024927.949Z-ee12c562",
      updatedAt,
      auditDegraded: false,
      config: {
        gatewayPaused: false,
        policy: {
          schemaVersion: 1,
          mode: "allowlist",
          revision: 1,
          rules: [],
        },
        bodyInspectionBytes: 1_048_576,
      },
    });

    assert(configuration.revision === 2, "configuration revision was lost");
    assert(
      configuration.updatedAt === updatedAt,
      "updatedAt was not preserved",
    );
  },
);

Deno.test("Active configuration still rejects unknown RPC fields", () => {
  let rejected = false;
  try {
    ActiveConfigSchema.parse({ initialized: false, unexpected: true });
  } catch {
    rejected = true;
  }
  assert(rejected, "unknown configuration fields were accepted");
});
