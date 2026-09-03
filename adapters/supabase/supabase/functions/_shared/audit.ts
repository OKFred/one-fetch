import { AuditEventV1Schema } from "@one-fetch/protocol";
import type { AuditEventV1, UnsignedAuditEventV1 } from "./protocol-types.ts";
import {
  redactAuditEvent,
  signAuditEvent as signCoreAuditEvent,
  verifyAuditEvent as verifyCoreAuditEvent,
} from "@one-fetch/core";

import { base64UrlToBytes } from "./crypto.ts";
import type { SupabaseEnvironment } from "./env.ts";

let cachedKey:
  | { encoded: string; privateKey: CryptoKey; publicKey: CryptoKey }
  | undefined;

async function importAuditKeys(encoded: string) {
  const keyData = Uint8Array.from(base64UrlToBytes(encoded)).buffer;
  const extractablePrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const privateJwk = await crypto.subtle.exportKey(
    "jwk",
    extractablePrivateKey,
  );
  if (!privateJwk.x) throw new Error("Audit signing key has no public key");
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { crv: "Ed25519", kty: "OKP", x: privateJwk.x },
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return { privateKey, publicKey };
}

async function auditKeys(environment: SupabaseEnvironment) {
  if (cachedKey?.encoded === environment.auditSigningPrivateKey)
    return cachedKey;
  cachedKey = {
    encoded: environment.auditSigningPrivateKey,
    ...(await importAuditKeys(environment.auditSigningPrivateKey)),
  };
  return cachedKey;
}

async function auditPrivateKey(
  environment: SupabaseEnvironment,
): Promise<CryptoKey> {
  return (await auditKeys(environment)).privateKey;
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

export async function verifyAuditEvent(
  event: AuditEventV1,
  environment: SupabaseEnvironment,
): Promise<boolean> {
  if (event.integrity.keyId !== environment.auditKeyId) return false;
  return verifyCoreAuditEvent(event, (await auditKeys(environment)).publicKey);
}
