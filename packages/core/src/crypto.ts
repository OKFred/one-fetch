const encoder = new TextEncoder();

function cryptoApi(): Crypto {
  if (globalThis.crypto === undefined) {
    throw new Error("Web Crypto is required");
  }
  return globalThis.crypto;
}

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value);
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("Expected Base64URL without padding");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") + padding,
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(length) || length < 1 || length > 65_536) {
    throw new RangeError("Random byte length must be between 1 and 65536");
  }
  return cryptoApi().getRandomValues(new Uint8Array(length));
}

export function randomNonce(): string {
  return bytesToHex(randomBytes(16));
}

export async function sha256Bytes(
  value: string | Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = typeof value === "string" ? utf8(value) : ownedBytes(value);
  return new Uint8Array(await cryptoApi().subtle.digest("SHA-256", bytes));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  return bytesToHex(await sha256Bytes(value));
}

export async function hmacBytes(
  key: string | Uint8Array | CryptoKey,
  value: string | Uint8Array,
  algorithm: "SHA-1" | "SHA-256" = "SHA-256",
): Promise<Uint8Array> {
  const cryptoKey =
    typeof key === "string" || key instanceof Uint8Array
      ? await cryptoApi().subtle.importKey(
          "raw",
          typeof key === "string" ? utf8(key) : ownedBytes(key),
          { name: "HMAC", hash: algorithm },
          false,
          ["sign"],
        )
      : key;
  const bytes = typeof value === "string" ? utf8(value) : ownedBytes(value);
  return new Uint8Array(
    await cryptoApi().subtle.sign("HMAC", cryptoKey, bytes),
  );
}

export async function hmacSha256Base64Url(
  key: string | Uint8Array | CryptoKey,
  value: string | Uint8Array,
): Promise<string> {
  return bytesToBase64Url(await hmacBytes(key, value));
}

export function constantTimeEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function normalizeJson(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON cannot contain non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object")
    throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
  if (seen.has(value))
    throw new TypeError("Canonical JSON cannot contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => normalizeJson(item, seen));
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined)
        throw new TypeError("Canonical JSON cannot contain undefined");
      normalized[key] = normalizeJson(record[key], seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeJson(value, new Set<object>()));
}

export async function deriveHmacKey(
  secret: string | Uint8Array,
  salt: string | Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const material = await cryptoApi().subtle.importKey(
    "raw",
    typeof secret === "string" ? utf8(secret) : ownedBytes(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return cryptoApi().subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: typeof salt === "string" ? utf8(salt) : ownedBytes(salt),
      info: utf8(info),
    },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}
