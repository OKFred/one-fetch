import {
  BootstrapRequestV1Schema,
  CreateExecutionTokenRequestV1Schema,
  LoginRequestV1Schema,
  ONE_FETCH_LIMITS_V1,
  PolicySetV1Schema,
  RefreshRequestV1Schema,
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

export const ConfigurationResponseSchema = z
  .object({
    controlGatewayPairId: z.string().min(1).max(128),
    policy: PolicySetV1Schema,
    updatedAt: z.iso.datetime({ offset: true }),
    version: z.string().min(1).max(256),
  })
  .strict();

export interface StoredConfig {
  instanceId?: string;
  initialized: boolean;
  gatewayPaused?: boolean;
  revision?: number;
  version?: string;
  config?: z.infer<typeof ConfigSchema>;
  updatedAt?: string;
}

export interface InstanceState {
  instanceId?: string;
  initialized: boolean;
  gatewayPaused?: boolean;
  configRevision?: number;
  configVersion?: string;
  updatedAt?: string;
  config?: { policy?: { mode?: "allowlist" | "blocklist" } };
}

export interface LoginRecord {
  adminId: string;
  passwordHash: string;
  failedLoginCount: number;
  lockedUntil?: string;
  totpConfigured: boolean;
}

export function configurationResponse(
  stored: StoredConfig,
  pairId: string,
): z.infer<typeof ConfigurationResponseSchema> {
  return ConfigurationResponseSchema.parse({
    controlGatewayPairId: pairId,
    policy: stored.config?.policy,
    updatedAt: stored.updatedAt,
    version: stored.version,
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
