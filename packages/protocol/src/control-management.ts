import { z } from "zod";

import { AuditEventV1Schema } from "./audit.js";
import { IsoDateTimeSchema } from "./common.js";
import {
  CreatedExecutionTokenV1Schema,
  ExecutionTokenRecordV1Schema,
} from "./control.js";
import { PolicySetV1Schema } from "./policy.js";

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const CursorSchema = z.string().min(1).max(1_024);

export const RuntimeConfigurationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: IdentifierSchema,
    controlGatewayPairId: IdentifierSchema,
    revision: z.number().int().nonnegative(),
    version: z.string().min(1).max(256),
    updatedAt: IsoDateTimeSchema,
    gatewayPaused: z.boolean(),
    policy: PolicySetV1Schema,
  })
  .strict();
export type RuntimeConfigurationV1 = z.infer<
  typeof RuntimeConfigurationV1Schema
>;

export const UpdatePolicyRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), policy: PolicySetV1Schema })
  .strict();
export type UpdatePolicyRequestV1 = z.infer<typeof UpdatePolicyRequestV1Schema>;

export const SetGatewayPausedRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), paused: z.boolean() })
  .strict();
export type SetGatewayPausedRequestV1 = z.infer<
  typeof SetGatewayPausedRequestV1Schema
>;

export const ExecutionTokenListV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    tokens: z.array(ExecutionTokenRecordV1Schema).max(10_000),
  })
  .strict();
export type ExecutionTokenListV1 = z.infer<typeof ExecutionTokenListV1Schema>;

export const ExecutionTokenCreateResponseV1Schema =
  CreatedExecutionTokenV1Schema;
export type ExecutionTokenCreateResponseV1 = z.infer<
  typeof ExecutionTokenCreateResponseV1Schema
>;

export const ExecutionTokenRevokeResponseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    revokedAt: IsoDateTimeSchema,
  })
  .strict();
export type ExecutionTokenRevokeResponseV1 = z.infer<
  typeof ExecutionTokenRevokeResponseV1Schema
>;

export const AuditPageV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    events: z.array(AuditEventV1Schema).max(1_000),
    nextCursor: CursorSchema.optional(),
  })
  .strict();
export type AuditPageV1 = z.infer<typeof AuditPageV1Schema>;

export const AuditPageQueryV1Schema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.number().int().min(1).max(1_000).default(100),
  })
  .strict();
export type AuditPageQueryV1 = z.infer<typeof AuditPageQueryV1Schema>;
