import {
  AuditPolicyDecisionV1Schema,
  HeaderEntryV1Schema,
  OneFetchTimingV1Schema,
  RequestIdSchema,
  Sha256HexSchema,
  TransportV1Schema,
} from "@one-fetch/protocol";
import { z } from "zod";

import { runtimeConfigSchema } from "./config";

export const authorizationInputSchema = z
  .object({
    token: z.string().min(16).max(4_096),
    requestId: RequestIdSchema,
    transport: TransportV1Schema,
    targetUrl: z.url().max(8_192),
    method: z.string().min(1).max(32),
    requestBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const authorizationResultSchema = z
  .object({
    allowed: z.boolean(),
    code: z.string().min(1).max(128).optional(),
    message: z.string().min(1).max(1_024).optional(),
    tokenId: z.string().min(1).max(128).optional(),
    config: runtimeConfigSchema.optional(),
    configVersion: z.string().min(1).max(256).optional(),
    auditState: z.enum(["recorded", "degraded"]),
    auditEventId: z.string().min(1).max(128).optional(),
  })
  .strict();

export const completionInputSchema = z
  .object({
    tokenId: z.string().min(1).max(128),
    requestId: RequestIdSchema,
    reportId: z.string().min(1).max(128),
    outcome: z.enum(["target", "relay-error", "partial", "cancelled"]),
    status: z.number().int().min(100).max(599).optional(),
    requestBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    responseBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    durationMs: z.number().nonnegative().finite(),
    timing: OneFetchTimingV1Schema,
    bodyComplete: z.boolean(),
    bodySha256: Sha256HexSchema.optional(),
    errorCode: z.string().min(1).max(128).optional(),
  })
  .strict();

export const executionDecisionInputSchema = z
  .object({
    tokenId: z.string().min(1).max(128),
    requestId: RequestIdSchema,
    transport: TransportV1Schema,
    targetUrl: z.url().max(8_192),
    method: z.string().min(1).max(32),
    requestBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    configVersion: z.string().min(1).max(256),
    headers: z.array(HeaderEntryV1Schema).max(256),
    contentType: z.string().max(1_024).optional(),
    code: z.string().min(1).max(128).optional(),
    decision: AuditPolicyDecisionV1Schema,
  })
  .strict();

export function parseJsonWithSchema<T>(json: string, schema: z.ZodType<T>): T {
  if (new TextEncoder().encode(json).byteLength > 1_048_576)
    throw new Error("payload_too_large");
  return schema.parse(JSON.parse(json) as unknown);
}
