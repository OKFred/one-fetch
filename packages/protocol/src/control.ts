import { z } from "zod";

import {
  IsoDateTimeSchema,
  RequestIdSchema,
  Sha256HexSchema,
} from "./common.js";
import { OneFetchTimingV1Schema, TransportV1Schema } from "./metadata.js";

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const OpaqueTokenSchema = z
  .string()
  .min(32)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes("\r") &&
      !value.includes("\n") &&
      !value.includes("\u0000"),
    "Token contains an invalid character",
  );

export const ControlErrorV1Schema = z
  .object({
    error: z
      .object({
        code: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-z0-9_]+$/u),
        message: z.string().min(1).max(1_024),
        retryable: z.boolean().optional(),
        correlationId: IdentifierSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type ControlErrorV1 = z.infer<typeof ControlErrorV1Schema>;

export const BootstrapStatusV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    initialized: z.boolean(),
    instanceId: IdentifierSchema,
  })
  .strict();
export type BootstrapStatusV1 = z.infer<typeof BootstrapStatusV1Schema>;

export const BootstrapRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    bootstrapSecret: OpaqueTokenSchema,
    username: z.string().min(3).max(64),
    password: z.string().min(12).max(1_024),
  })
  .strict();
export type BootstrapRequestV1 = z.infer<typeof BootstrapRequestV1Schema>;

export const LoginRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(1_024),
    totpCode: z
      .string()
      .regex(/^(?:[0-9]{6}|[0-9]{8})$/u)
      .optional(),
    recoveryCode: z.string().min(8).max(256).optional(),
    deviceFingerprint: z.string().min(1).max(256).optional(),
    rememberDevice: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      !(value.totpCode !== undefined && value.recoveryCode !== undefined),
    {
      message: "Use either a TOTP code or a recovery code, not both",
    },
  );
export type LoginRequestV1 = z.infer<typeof LoginRequestV1Schema>;

export const RefreshRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), refreshToken: OpaqueTokenSchema })
  .strict();
export type RefreshRequestV1 = z.infer<typeof RefreshRequestV1Schema>;

export const SessionTokenPairV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    accessToken: OpaqueTokenSchema,
    accessExpiresAt: IsoDateTimeSchema,
    refreshToken: OpaqueTokenSchema,
    refreshExpiresAt: IsoDateTimeSchema,
    sessionId: IdentifierSchema,
  })
  .strict();
export type SessionTokenPairV1 = z.infer<typeof SessionTokenPairV1Schema>;

export const ExecutionQuotaV1Schema = z
  .object({
    requestsPerMinute: z.number().int().positive().max(1_000_000),
    burst: z.number().int().positive().max(1_000_000),
    concurrentHttp: z.number().int().nonnegative().max(100_000),
    concurrentTunnels: z.number().int().nonnegative().max(100_000),
    bytesPerDay: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ExecutionQuotaV1 = z.infer<typeof ExecutionQuotaV1Schema>;

export const ExecutionTokenScopeV1Schema = z
  .object({
    transports: z.array(TransportV1Schema).min(1).max(4),
    origins: z.array(z.string().min(1).max(2_048)).max(256),
    ports: z.array(z.number().int().min(1).max(65_535)).max(256),
  })
  .strict();
export type ExecutionTokenScopeV1 = z.infer<typeof ExecutionTokenScopeV1Schema>;

export const CreateExecutionTokenRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1).max(128),
    scope: ExecutionTokenScopeV1Schema,
    quota: ExecutionQuotaV1Schema,
    expiresAt: IsoDateTimeSchema.optional(),
  })
  .strict();
export type CreateExecutionTokenRequestV1 = z.infer<
  typeof CreateExecutionTokenRequestV1Schema
>;

export const ExecutionTokenRecordV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    name: z.string().min(1).max(128),
    scope: ExecutionTokenScopeV1Schema,
    quota: ExecutionQuotaV1Schema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.optional(),
    revokedAt: IsoDateTimeSchema.optional(),
  })
  .strict();
export type ExecutionTokenRecordV1 = z.infer<
  typeof ExecutionTokenRecordV1Schema
>;

export const CreatedExecutionTokenV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    credential: ExecutionTokenRecordV1Schema,
    token: OpaqueTokenSchema,
  })
  .strict();
export type CreatedExecutionTokenV1 = z.infer<
  typeof CreatedExecutionTokenV1Schema
>;

export const ExecutionReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    reportId: IdentifierSchema,
    requestId: RequestIdSchema,
    outcome: z.enum([
      "completed",
      "partial",
      "timeout",
      "cancelled",
      "relay-error",
      "orphaned",
    ]),
    source: z.enum(["target", "relay", "vendor", "unknown"]),
    status: z.number().int().min(100).max(599).optional(),
    responseBytes: z.number().int().nonnegative(),
    bodyComplete: z.boolean(),
    bodySha256: Sha256HexSchema.optional(),
    timing: OneFetchTimingV1Schema,
    finishedAt: IsoDateTimeSchema,
    auditState: z.enum(["recorded", "degraded", "unknown"]),
  })
  .strict();
export type ExecutionReportV1 = z.infer<typeof ExecutionReportV1Schema>;

export const AlertEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    alertId: IdentifierSchema,
    instanceId: IdentifierSchema,
    occurredAt: IsoDateTimeSchema,
    severity: z.enum(["warning", "error", "critical"]),
    type: z.string().min(1).max(128),
    summary: z.string().min(1).max(1_024),
    correlationId: z.string().min(1).max(128).optional(),
    configVersion: z.string().min(1).max(256).optional(),
    counters: z
      .record(z.string().min(1).max(128), z.number().finite())
      .optional(),
  })
  .strict();
export type AlertEventV1 = z.infer<typeof AlertEventV1Schema>;
