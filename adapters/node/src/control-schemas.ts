import { z } from "@hono/zod-openapi";

export const ErrorResponseSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }).strict(),
  })
  .strict();

export const HealthResponseSchema = z
  .object({
    instanceId: z.string(),
    service: z.literal("one-fetch-control"),
    status: z.enum(["ok", "degraded"]),
    version: z.string(),
  })
  .strict();

export const BootstrapRequestSchema = z
  .object({
    bootstrapSecret: z.string().min(32).max(512),
    password: z.string().min(12).max(1_024),
    username: z.string().min(3).max(64),
  })
  .strict();

export const LoginRequestSchema = z
  .object({ password: z.string().max(1_024), username: z.string().max(64) })
  .strict();

export const RefreshRequestSchema = z
  .object({ refreshToken: z.string().min(32).max(512) })
  .strict();

export const SessionResponseSchema = z
  .object({
    accessExpiresAt: z.string(),
    accessToken: z.string(),
    refreshExpiresAt: z.string(),
    refreshToken: z.string(),
  })
  .strict();

export const CreateExecutionTokenSchema = z
  .object({
    allowedOrigins: z.array(z.url()).max(256),
    scopes: z
      .array(z.enum(["http", "websocket", "tcp", "tls"]))
      .min(1)
      .max(4),
  })
  .strict();

export const ExecutionTokenResponseSchema = z
  .object({
    credential: z.object({
      allowedOrigins: z.array(z.string()),
      expiresAt: z.string(),
      id: z.string(),
      scopes: z.array(z.string()),
    }),
    token: z.string(),
  })
  .strict();

export const PolicyDocumentSchema = z
  .object({
    mode: z.enum(["allowlist", "blocklist"]),
    revision: z.number().int().nonnegative(),
    rules: z.array(z.record(z.string(), z.any())),
    schemaVersion: z.literal(1),
  })
  .strict();

export const ConfigurationResponseSchema = z
  .object({
    controlGatewayPairId: z.string(),
    policy: PolicyDocumentSchema,
    updatedAt: z.string(),
    version: z.string(),
  })
  .strict();

// A full JSON Schema for capabilities is shipped from packages/protocol. Keeping
// the route schema opaque avoids a zod-to-openapi recursion bug on JsonValue.
export const CapabilitiesResponseSchema = z.any();

export const AuditListSchema = z
  .object({
    items: z.array(z.record(z.string(), z.unknown())),
    nextBeforeSequence: z.number().int().positive().optional(),
  })
  .strict();

export const ExecutionReportSchema = z
  .object({
    bodyComplete: z.boolean(),
    bodySha256: z.string().optional(),
    finishedAt: z.string(),
    outcome: z.enum([
      "completed",
      "partial",
      "timeout",
      "cancelled",
      "relay-error",
    ]),
    requestId: z.string(),
    responseBytes: z.number().int().nonnegative(),
    timing: z
      .object({
        downloadMs: z.number().nonnegative().optional(),
        totalMs: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();
