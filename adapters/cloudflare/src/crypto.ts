const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return new Uint8Array(
    Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

export async function sha256Bytes(
  value: string | Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(input)),
  );
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  return [...(await sha256Bytes(value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacSha256Hex(
  key: string,
  value: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(value),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function constantTimeTextEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    sha256Bytes(left),
    sha256Bytes(right),
  ]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1)
    difference |= leftHash[index]! ^ rightHash[index]!;
  return difference === 0;
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

async function importAesKey(encodedKey: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(encodedKey);
  if (bytes.byteLength !== 32)
    throw new Error("ENCRYPTION_KEY must contain exactly 32 bytes");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(
  value: string,
  encodedKey: string,
): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await importAesKey(encodedKey);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(value),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(
  value: string,
  encodedKey: string,
): Promise<string> {
  const [version, encodedIv, encodedCiphertext] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext)
    throw new Error("Unsupported encrypted value");
  const key = await importAesKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(encodedIv) },
    key,
    base64UrlToBytes(encodedCiphertext),
  );
  return decoder.decode(plaintext);
}

export async function signAuditPayload(
  payload: string,
  encodedPkcs8: string,
): Promise<{ keyId: string; signature: string }> {
  const privateBytes = base64UrlToBytes(encodedPkcs8);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateBytes,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key,
    encoder.encode(payload),
  );
  return {
    keyId: (await sha256Hex(privateBytes)).slice(0, 16),
    signature: bytesToBase64Url(new Uint8Array(signature)),
  };
}
