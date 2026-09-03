import { z } from "zod";

import { IsoDateTimeSchema, Sha256HexSchema } from "./common.js";
import { AlertEventV1Schema } from "./control.js";

export const ControlFeatureV1Schema = z.enum([
  "alerts",
  "backups",
  "audit-export",
  "gateway-pause",
  "sessions",
  "totp",
  "password-change",
  "webhooks",
]);
export type ControlFeatureV1 = z.infer<typeof ControlFeatureV1Schema>;

const FeatureIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  feature: ControlFeatureV1Schema,
});

const SupportedFeatureV1Schema = FeatureIdentitySchema.extend({
  state: z.literal("supported"),
  detail: z.string().min(1).max(1_024).optional(),
}).strict();

const DegradedFeatureV1Schema = FeatureIdentitySchema.extend({
  state: z.literal("degraded"),
  reason: z.string().min(1).max(1_024),
}).strict();

export const UnsupportedFeatureV1Schema = FeatureIdentitySchema.extend({
  state: z.literal("unsupported"),
  reason: z.string().min(1).max(1_024),
}).strict();
export type UnsupportedFeatureV1 = z.infer<typeof UnsupportedFeatureV1Schema>;

export const ControlFeatureStatusV1Schema = z.discriminatedUnion("state", [
  SupportedFeatureV1Schema,
  DegradedFeatureV1Schema,
  UnsupportedFeatureV1Schema,
]);
export type ControlFeatureStatusV1 = z.infer<
  typeof ControlFeatureStatusV1Schema
>;

export const ControlFeatureStatusListV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    features: z.array(ControlFeatureStatusV1Schema).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.features.forEach((feature, index) => {
      if (seen.has(feature.feature)) {
        context.addIssue({
          code: "custom",
          message: "Feature status entries must be unique",
          path: ["features", index, "feature"],
        });
      }
      seen.add(feature.feature);
    });
  });
export type ControlFeatureStatusListV1 = z.infer<
  typeof ControlFeatureStatusListV1Schema
>;

const AlertPageFields = {
  schemaVersion: z.literal(1),
  feature: z.literal("alerts"),
  alerts: z.array(AlertEventV1Schema).max(1_000),
  nextCursor: z.string().min(1).max(1_024).optional(),
} as const;

export const AlertsResponseV1Schema = z.discriminatedUnion("state", [
  z.object({ ...AlertPageFields, state: z.literal("supported") }).strict(),
  z
    .object({
      ...AlertPageFields,
      state: z.literal("degraded"),
      reason: z.string().min(1).max(1_024),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      feature: z.literal("alerts"),
      state: z.literal("unsupported"),
      reason: z.string().min(1).max(1_024),
    })
    .strict(),
]);
export type AlertsResponseV1 = z.infer<typeof AlertsResponseV1Schema>;

export const BackupRecordV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    backupId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/u),
    createdAt: IsoDateTimeSchema,
    kind: z.enum(["manual", "scheduled"]),
    state: z.enum(["pending", "complete", "failed"]),
    sizeBytes: z.number().int().nonnegative().optional(),
    sha256: Sha256HexSchema.optional(),
    expiresAt: IsoDateTimeSchema.optional(),
  })
  .strict();
export type BackupRecordV1 = z.infer<typeof BackupRecordV1Schema>;

const BackupPageFields = {
  schemaVersion: z.literal(1),
  feature: z.literal("backups"),
  backups: z.array(BackupRecordV1Schema).max(1_000),
  nextCursor: z.string().min(1).max(1_024).optional(),
} as const;

export const BackupsResponseV1Schema = z.discriminatedUnion("state", [
  z.object({ ...BackupPageFields, state: z.literal("supported") }).strict(),
  z
    .object({
      ...BackupPageFields,
      state: z.literal("degraded"),
      reason: z.string().min(1).max(1_024),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      feature: z.literal("backups"),
      state: z.literal("unsupported"),
      reason: z.string().min(1).max(1_024),
    })
    .strict(),
]);
export type BackupsResponseV1 = z.infer<typeof BackupsResponseV1Schema>;
