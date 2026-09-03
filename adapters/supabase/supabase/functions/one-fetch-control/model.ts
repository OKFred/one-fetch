import {
  BootstrapRequestV1Schema,
  ControlFeatureStatusListV1Schema,
  CreateExecutionTokenRequestV1Schema,
  IsoDateTimeSchema,
  LoginRequestV1Schema,
  ONE_FETCH_LIMITS_V1,
  PolicySetV1Schema,
  RefreshRequestV1Schema,
  RuntimeConfigurationV1Schema,
} from "@one-fetch/protocol";
import { z } from "zod";

export const BootstrapSchema = BootstrapRequestV1Schema;
export const LoginSchema = LoginRequestV1Schema;
export const RefreshSchema = RefreshRequestV1Schema;
export const TokenSchema = CreateExecutionTokenRequestV1Schema;

export const ConfigSchema = z
  .object({
    gatewayPaused: z.boolean(),
    policy: PolicySetV1Schema,
    bodyInspectionBytes: z
      .number()
      .int()
      .min(0)
      .max(ONE_FETCH_LIMITS_V1.inspectableBodyBytes),
    audit: z
      .object({
        executionRetentionDays: z.number().int().min(1).max(3650),
        securityRetentionDays: z.number().int().min(1).max(3650),
        sealRetentionDays: z.number().int().min(1).max(3650),
      })
      .strict(),
  })
  .strict();

const StoredConfigFields = {
  instanceId: z.string().uuid(),
  gatewayPaused: z.boolean(),
  revision: z.number().int().nonnegative(),
  version: z.string().min(1).max(256),
  config: ConfigSchema,
  updatedAt: IsoDateTimeSchema,
  auditDegraded: z.boolean(),
};

export const InitializedStoredConfigSchema = z
  .object({
    initialized: z.literal(true),
    ...StoredConfigFields,
  })
  .strict();

const UninitializedStoredConfigSchema = z
  .object({
    initialized: z.literal(false),
    auditDegraded: z.boolean(),
    instanceId: StoredConfigFields.instanceId.optional(),
    gatewayPaused: StoredConfigFields.gatewayPaused.optional(),
    revision: StoredConfigFields.revision.optional(),
    version: StoredConfigFields.version.optional(),
    config: StoredConfigFields.config.optional(),
    updatedAt: StoredConfigFields.updatedAt.optional(),
  })
  .strict();

export const StoredConfigSchema = z.discriminatedUnion("initialized", [
  InitializedStoredConfigSchema,
  UninitializedStoredConfigSchema,
]);
export type StoredConfig = z.infer<typeof StoredConfigSchema>;
export type InitializedStoredConfig = z.infer<
  typeof InitializedStoredConfigSchema
>;

const InstanceStateFields = {
  instanceId: z.string().uuid(),
  gatewayPaused: z.boolean(),
  configRevision: z.number().int().nonnegative(),
  configVersion: z.string().min(1).max(256),
  updatedAt: IsoDateTimeSchema,
  auditDegraded: z.boolean(),
};

export const InstanceStateSchema = z.discriminatedUnion("initialized", [
  z.object({ initialized: z.literal(true), ...InstanceStateFields }).strict(),
  z
    .object({
      initialized: z.literal(false),
      auditDegraded: z.boolean(),
      instanceId: InstanceStateFields.instanceId.optional(),
      gatewayPaused: InstanceStateFields.gatewayPaused.optional(),
      configRevision: InstanceStateFields.configRevision.optional(),
      configVersion: InstanceStateFields.configVersion.optional(),
      updatedAt: InstanceStateFields.updatedAt.optional(),
    })
    .strict(),
]);
export type InstanceState = z.infer<typeof InstanceStateSchema>;

export const LoginRecordSchema = z
  .object({
    adminId: z.string().uuid(),
    passwordHash: z.string().min(1).max(512),
    failedLoginCount: z.number().int().nonnegative(),
    lockedUntil: IsoDateTimeSchema.nullable(),
    totpConfigured: z.boolean(),
  })
  .strict()
  .nullable();
export type LoginRecord = z.infer<typeof LoginRecordSchema>;

export class InstanceMismatchError extends Error {
  constructor() {
    super("Stored instance ID does not match the configured instance ID");
    this.name = "InstanceMismatchError";
  }
}

export function assertMatchingInstance(
  stored: { instanceId?: string | undefined },
  expectedInstanceId: string,
): void {
  if (
    stored.instanceId !== undefined &&
    stored.instanceId !== expectedInstanceId
  ) {
    throw new InstanceMismatchError();
  }
}

export function configurationResponse(
  stored: InitializedStoredConfig,
  pairId: string,
): z.infer<typeof RuntimeConfigurationV1Schema> {
  return RuntimeConfigurationV1Schema.parse({
    schemaVersion: 1,
    instanceId: stored.instanceId,
    controlGatewayPairId: pairId,
    revision: stored.revision,
    policy: stored.config.policy,
    gatewayPaused: stored.config.gatewayPaused,
    updatedAt: stored.updatedAt,
    version: stored.version,
  });
}

export function featureStatuses() {
  return ControlFeatureStatusListV1Schema.parse({
    schemaVersion: 1,
    features: [
      {
        schemaVersion: 1,
        feature: "alerts",
        state: "unsupported",
        reason:
          "Signed Webhook alerts are not available in the Supabase Preview",
      },
      {
        schemaVersion: 1,
        feature: "backups",
        state: "unsupported",
        reason:
          "Managed backup orchestration is not available in the Supabase Preview",
      },
      {
        schemaVersion: 1,
        feature: "audit-export",
        state: "unsupported",
        reason:
          "Signed JSONL audit export is not available in the Supabase Preview",
      },
      { schemaVersion: 1, feature: "gateway-pause", state: "supported" },
      { schemaVersion: 1, feature: "sessions", state: "supported" },
      {
        schemaVersion: 1,
        feature: "totp",
        state: "unsupported",
        reason: "TOTP enrollment is not available in the Supabase Preview",
      },
      { schemaVersion: 1, feature: "password-change", state: "supported" },
      {
        schemaVersion: 1,
        feature: "webhooks",
        state: "unsupported",
        reason: "Webhook delivery is not available in the Supabase Preview",
      },
    ],
  });
}

export function defaultConfig(): z.infer<typeof ConfigSchema> {
  return {
    gatewayPaused: false,
    policy: { schemaVersion: 1, mode: "allowlist", revision: 0, rules: [] },
    bodyInspectionBytes: ONE_FETCH_LIMITS_V1.inspectableBodyBytes,
    audit: {
      executionRetentionDays: 30,
      securityRetentionDays: 180,
      sealRetentionDays: 400,
    },
  };
}

export function configVersion(now: Date, hash: string): string {
  const stamp = now
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".000", ".000");
  return `${stamp}-${hash.slice(0, 8)}`;
}
