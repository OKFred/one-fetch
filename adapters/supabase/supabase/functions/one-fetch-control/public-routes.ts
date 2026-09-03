import type { Hono } from "hono";
import {
  BootstrapStatusV1Schema,
  HealthResponseV1Schema,
} from "@one-fetch/protocol";
import { z } from "zod";

import { buildSupabaseCapabilities } from "../_shared/capabilities.ts";
import { type Database, parseStorageResult } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { createSupabaseOpenApi } from "./openapi.ts";
import {
  assertMatchingInstance,
  InstanceStateSchema,
  StoredConfigSchema,
} from "./model.ts";

const RuntimeStateFields = {
  auditDegraded: z.boolean(),
  migrations: z.array(
    z.object({ version: z.string(), checksum: z.string() }).strict(),
  ),
};

const RuntimeStateSchema = z.discriminatedUnion("initialized", [
  z
    .object({
      initialized: z.literal(true),
      instanceId: z.string().uuid(),
      ...RuntimeStateFields,
    })
    .strict(),
  z
    .object({
      initialized: z.literal(false),
      instanceId: z.string().uuid().optional(),
      ...RuntimeStateFields,
    })
    .strict(),
]);

export function registerPublicRoutes(
  app: Hono,
  environment: SupabaseEnvironment,
  database: Database,
): void {
  app.get("/api/v1/health", async (context) => {
    const state = parseStorageResult(
      "of_get_control_runtime_state",
      RuntimeStateSchema,
      await database.rpc<unknown>("of_get_control_runtime_state"),
    );
    assertMatchingInstance(state, environment.instanceId);
    return context.json(
      HealthResponseV1Schema.parse({
        instanceId: state.instanceId ?? environment.instanceId,
        service: "one-fetch-control",
        status: state.auditDegraded ? "degraded" : "ok",
        version: environment.buildVersion,
      }),
    );
  });

  app.get("/api/v1/openapi.json", (context) =>
    context.json(createSupabaseOpenApi(context.req.raw)),
  );

  app.get("/api/v1/capabilities", async (context) => {
    const stored = parseStorageResult(
      "of_get_active_config",
      StoredConfigSchema,
      await database.rpc<unknown>("of_get_active_config"),
    );
    assertMatchingInstance(stored, environment.instanceId);
    const capabilities = buildSupabaseCapabilities(
      {
        initialized: stored.initialized,
        auditDegraded: stored.auditDegraded,
        ...(stored.instanceId === undefined
          ? {}
          : { instanceId: stored.instanceId }),
        ...(stored.version === undefined
          ? {}
          : { configVersion: stored.version }),
        ...(stored.updatedAt === undefined
          ? {}
          : { updatedAt: stored.updatedAt }),
        ...(stored.config === undefined ? {} : { config: stored.config }),
      },
      environment,
    );
    return context.json(capabilities, 200, {
      etag: `"${capabilities.configVersion}"`,
    });
  });

  const bootstrapStatus = async () => {
    const state = parseStorageResult(
      "of_get_instance_state",
      InstanceStateSchema,
      await database.rpc<unknown>("of_get_instance_state"),
    );
    assertMatchingInstance(state, environment.instanceId);
    return BootstrapStatusV1Schema.parse({
      schemaVersion: 1,
      initialized: state.initialized,
      instanceId: state.instanceId ?? environment.instanceId,
    });
  };
  app.get("/api/v1/bootstrap", async (context) =>
    context.json(await bootstrapStatus()),
  );
}
