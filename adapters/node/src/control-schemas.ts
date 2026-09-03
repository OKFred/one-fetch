import { z } from "@hono/zod-openapi";

export const HealthResponseSchema = z
  .object({
    instanceId: z.string(),
    service: z.literal("one-fetch-control"),
    status: z.enum(["ok", "degraded"]),
    version: z.string(),
  })
  .strict();

// Capabilities are validated while assembled. Keeping this OpenAPI route
// schema opaque avoids recursion bugs when JsonValue is converted to OpenAPI.
export const CapabilitiesResponseSchema = z.any();
export const OpaqueJsonSchema = z.any();
