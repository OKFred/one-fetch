import { z } from "zod";

import { IsoDateTimeSchema } from "./common.js";

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const PasswordSchema = z.string().min(12).max(1_024);
const RecoveryCodeSchema = z.string().min(8).max(256);

export const SessionRecordV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    createdAt: IsoDateTimeSchema,
    lastSeenAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    current: z.boolean(),
    deviceFingerprint: z.string().min(1).max(256).optional(),
  })
  .strict();
export type SessionRecordV1 = z.infer<typeof SessionRecordV1Schema>;

export const SessionListV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sessions: z.array(SessionRecordV1Schema).max(10_000),
  })
  .strict();
export type SessionListV1 = z.infer<typeof SessionListV1Schema>;

export const SessionRevokeResponseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: IdentifierSchema,
    revokedAt: IsoDateTimeSchema,
  })
  .strict();
export type SessionRevokeResponseV1 = z.infer<
  typeof SessionRevokeResponseV1Schema
>;

export const LogoutResponseV1Schema = SessionRevokeResponseV1Schema;
export type LogoutResponseV1 = z.infer<typeof LogoutResponseV1Schema>;

export const TotpPrepareResponseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    secret: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Z2-7]+$/u),
    otpauthUri: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => value.startsWith("otpauth://totp/"), {
        message: "Expected an otpauth TOTP URI",
      }),
  })
  .strict();
export type TotpPrepareResponseV1 = z.infer<typeof TotpPrepareResponseV1Schema>;

export const TotpEnableRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    code: z.string().regex(/^(?:[0-9]{6}|[0-9]{8})$/u),
  })
  .strict();
export type TotpEnableRequestV1 = z.infer<typeof TotpEnableRequestV1Schema>;

export const TotpEnableResponseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    enabledAt: IsoDateTimeSchema,
    recoveryCodes: z.array(RecoveryCodeSchema).min(1).max(64),
  })
  .strict();
export type TotpEnableResponseV1 = z.infer<typeof TotpEnableResponseV1Schema>;

export const ChangePasswordRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    currentPassword: z.string().min(1).max(1_024),
    newPassword: PasswordSchema,
  })
  .strict()
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: "New password must differ from the current password",
    path: ["newPassword"],
  });
export type ChangePasswordRequestV1 = z.infer<
  typeof ChangePasswordRequestV1Schema
>;

export const ChangePasswordResponseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    changedAt: IsoDateTimeSchema,
    revokedSessionIds: z.array(IdentifierSchema).max(10_000),
  })
  .strict();
export type ChangePasswordResponseV1 = z.infer<
  typeof ChangePasswordResponseV1Schema
>;
