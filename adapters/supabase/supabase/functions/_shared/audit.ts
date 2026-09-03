import {
  AuditEventV1Schema,
  type AuditEventV1,
  type UnsignedAuditEventV1,
} from "@one-fetch/protocol";
import {
  redactAuditEvent,
  signAuditEvent as signCoreAuditEvent,
} from "@one-fetch/core";

import { base64UrlToBytes } from "./crypto.ts";
import type { SupabaseEnvironment } from "./env.ts";

let cachedKey: { encoded: string; key: CryptoKey } | undefined;

async function auditPrivateKey(
  environment: SupabaseEnvironment,
): Promise<CryptoKey> {
  if (cachedKey?.encoded === environment.auditSigningPrivateKey)
    return cachedKey.key;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(base64UrlToBytes(environment.auditSigningPrivateKey))
      .buffer,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  cachedKey = { encoded: environment.auditSigningPrivateKey, key };
  return key;
}

export async function signAuditEvent(
  event: UnsignedAuditEventV1,
  environment: SupabaseEnvironment,
): Promise<AuditEventV1> {
  return AuditEventV1Schema.parse(
    await signCoreAuditEvent(
      redactAuditEvent(event),
      await auditPrivateKey(environment),
      environment.auditKeyId,
    ),
  );
}

type AuditEventInput = Omit<
  UnsignedAuditEventV1,
  "schemaVersion" | "eventId" | "occurredAt" | "recordedAt"
>;

export async function createAuditEvent(
  input: AuditEventInput,
  environment: SupabaseEnvironment,
): Promise<AuditEventV1> {
  const now = new Date().toISOString();
  return signAuditEvent(
    {
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      occurredAt: now,
      recordedAt: now,
      ...input,
    },
    environment,
  );
}
