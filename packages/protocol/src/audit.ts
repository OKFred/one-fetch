import { z } from "zod";

import {
  Base64UrlSchema,
  IsoDateTimeSchema,
  RequestIdSchema,
  Sha256HexSchema,
} from "./common.js";
import { TransportV1Schema } from "./metadata.js";

export const AuditCategoryV1Schema = z.enum([
  "execution",
  "auth",
  "account",
  "config",
  "security",
  "system",
  "audit",
]);

export const AuditHeaderV1Schema = z
  .object({
    name: z.string().min(1).max(256),
    value: z.string().max(2_048),
  })
  .strict();
export type AuditHeaderV1 = z.infer<typeof AuditHeaderV1Schema>;

export const AuditRequestSummaryV1Schema = z
  .object({
    transport: TransportV1Schema,
    method: z.string().min(1).max(32).optional(),
    origin: z.string().max(2_048).optional(),
    path: z.string().max(8_192).optional(),
    query: z
      .array(z.tuple([z.string().max(1_024), z.string().max(4_096)]))
      .max(256)
      .optional(),
    headers: z.array(AuditHeaderV1Schema).max(256).optional(),
    contentType: z.string().max(1_024).optional(),
  })
  .strict();
export type AuditRequestSummaryV1 = z.infer<typeof AuditRequestSummaryV1Schema>;

export const AuditPolicyDecisionV1Schema = z
  .object({
    decision: z.enum(["allow", "deny"]),
    source: z.enum(["default", "system-rule", "user-rule"]),
    ruleId: z.string().min(1).max(128).optional(),
    warnings: z.array(z.string().max(1_024)).max(64),
  })
  .strict();

export const AuditResultV1Schema = z
  .object({
    source: z.enum(["target", "relay", "vendor", "unknown"]),
    status: z.number().int().min(100).max(599).optional(),
    stage: z.string().max(128).optional(),
    code: z.string().max(128).optional(),
  })
  .strict();

const AuditEventBaseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().min(1).max(128),
    occurredAt: IsoDateTimeSchema,
    recordedAt: IsoDateTimeSchema,
    category: AuditCategoryV1Schema,
    action: z.string().min(1).max(128),
    outcome: z.enum(["success", "denied", "failure", "partial", "unknown"]),
    severity: z.enum(["info", "warning", "error", "critical"]),
    actor: z
      .object({
        type: z.enum(["admin", "execution-token", "system", "anonymous"]),
        actorId: z.string().min(1).max(128).optional(),
        credentialId: z.string().min(1).max(128).optional(),
        sessionFingerprint: z.string().min(1).max(256).optional(),
      })
      .strict(),
    correlation: z
      .object({
        requestId: RequestIdSchema.optional(),
        reportId: z.string().min(1).max(128).optional(),
        connectionId: z.string().min(1).max(128).optional(),
        configVersion: z.string().min(1).max(256).optional(),
        providerRequestId: z.string().min(1).max(256).optional(),
      })
      .strict(),
    request: AuditRequestSummaryV1Schema.optional(),
    decision: AuditPolicyDecisionV1Schema.optional(),
    result: AuditResultV1Schema.optional(),
    change: z
      .object({
        beforeVersion: z.string().max(256).optional(),
        afterVersion: z.string().max(256).optional(),
        beforeHash: Sha256HexSchema.optional(),
        afterHash: Sha256HexSchema.optional(),
        changedFields: z.array(z.string().min(1).max(256)).max(256),
      })
      .strict()
      .optional(),
    metrics: z
      .object({
        requestBytes: z.number().int().nonnegative().optional(),
        responseBytes: z.number().int().nonnegative().optional(),
        redirects: z.number().int().nonnegative().optional(),
        durationMs: z.number().nonnegative().finite().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const UnsignedAuditEventV1Schema = AuditEventBaseV1Schema;
export type UnsignedAuditEventV1 = z.infer<typeof UnsignedAuditEventV1Schema>;

export const AuditEventV1Schema = z.intersection(
  AuditEventBaseV1Schema,
  z
    .object({
      integrity: z
        .object({
          payloadHash: Sha256HexSchema,
          signature: Base64UrlSchema,
          keyId: z.string().min(1).max(128),
        })
        .strict(),
    })
    .strict(),
);
export type AuditEventV1 = z.infer<typeof AuditEventV1Schema>;

export const AuditRedactionConfigV1Schema = z
  .object({
    replacement: z.string().min(1).max(128),
    sensitiveNames: z.array(z.string().min(1).max(256)).max(256),
    pathSegmentIndexes: z.array(z.number().int().nonnegative()).max(128),
    preserveQueryNames: z.boolean(),
  })
  .strict();
export type AuditRedactionConfigV1 = z.infer<
  typeof AuditRedactionConfigV1Schema
>;
