import { hmacSha256Hex, randomToken } from "./crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const encoder = new TextEncoder();

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string): Uint8Array {
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const character of value.toUpperCase().replaceAll(/[^A-Z2-7]/gu, "")) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 value");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
}

export function createTotpSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return encodeBase32(bytes);
}

async function generateTotp(secret: string, counter: number): Promise<string> {
  const counterBytes = new Uint8Array(8);
  const view = new DataView(counterBytes.buffer);
  view.setUint32(4, counter, false);
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(decodeBase32(secret)),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, counterBytes),
  );
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export async function verifyTotp(
  secret: string,
  code: string,
  now = Date.now(),
): Promise<boolean> {
  if (!/^\d{6}$/u.test(code)) return false;
  const counter = Math.floor(now / 30_000);
  const candidates = await Promise.all(
    [-1, 0, 1].map((offset) => generateTotp(secret, counter + offset)),
  );
  const supplied = encoder.encode(code);
  return candidates.some((candidate) =>
    constantTimeEqual(encoder.encode(candidate), supplied),
  );
}

export function createRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const token = randomToken(9)
      .replaceAll(/[^A-Za-z0-9]/gu, "")
      .toUpperCase()
      .padEnd(12, "X")
      .slice(0, 12);
    return `${token.slice(0, 4)}-${token.slice(4, 8)}-${token.slice(8, 12)}`;
  });
}

export async function hashRecoveryCode(
  code: string,
  pepper: string,
): Promise<string> {
  return hmacSha256Hex(
    pepper,
    code.replaceAll(/[^A-Za-z0-9]/gu, "").toUpperCase(),
  );
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}
