import {
  AuditEventV1Schema,
  UnsignedAuditEventV1Schema,
  type AuditEventV1,
  type UnsignedAuditEventV1,
} from "@one-fetch/protocol";

import {
  base64UrlToBytes,
  bytesToBase64Url,
  sha256Hex,
  stableStringify,
  utf8,
} from "./crypto.js";

export async function generateAuditSigningKeyPair(): Promise<CryptoKeyPair> {
  const keys = await globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in keys))
    throw new Error("Ed25519 key generation did not return a key pair");
  return keys;
}

export async function signAuditEvent(
  event: UnsignedAuditEventV1,
  privateKey: CryptoKey,
  keyId: string,
): Promise<AuditEventV1> {
  const parsed = UnsignedAuditEventV1Schema.parse(event);
  const payload = stableStringify(parsed);
  const signature = await globalThis.crypto.subtle.sign(
    "Ed25519",
    privateKey,
    utf8(payload),
  );
  return AuditEventV1Schema.parse({
    ...parsed,
    integrity: {
      payloadHash: await sha256Hex(payload),
      signature: bytesToBase64Url(new Uint8Array(signature)),
      keyId,
    },
  });
}

export async function verifyAuditEvent(
  event: AuditEventV1,
  publicKey: CryptoKey,
): Promise<boolean> {
  const parsed = AuditEventV1Schema.safeParse(event);
  if (!parsed.success) return false;
  const { integrity, ...unsignedCandidate } = parsed.data;
  const unsigned = UnsignedAuditEventV1Schema.parse(unsignedCandidate);
  const payload = stableStringify(unsigned);
  if ((await sha256Hex(payload)) !== integrity.payloadHash) return false;
  try {
    return await globalThis.crypto.subtle.verify(
      "Ed25519",
      publicKey,
      base64UrlToBytes(integrity.signature),
      utf8(payload),
    );
  } catch {
    return false;
  }
}
