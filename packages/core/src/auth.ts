import {
  bytesToBase64Url,
  hmacBytes,
  randomBytes,
  sha256Hex,
  utf8,
} from "./crypto.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(bytes: Uint8Array): string {
  let accumulator = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(value: string): Uint8Array {
  const uppercase = value.toUpperCase();
  let unpaddedLength = uppercase.length;
  while (
    unpaddedLength > 0 &&
    uppercase.charCodeAt(unpaddedLength - 1) === 61
  ) {
    unpaddedLength -= 1;
  }
  const normalized = uppercase.slice(0, unpaddedLength);
  if (!/^[A-Z2-7]+$/u.test(normalized))
    throw new TypeError("Expected an unpadded Base32 value");
  let accumulator = 0;
  let bits = 0;
  const output: number[] = [];
  for (const character of normalized) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}

export function generateOpaqueToken(prefix = "of"): string {
  if (!/^[a-z][a-z0-9_-]{0,15}$/u.test(prefix))
    throw new TypeError("Invalid token prefix");
  return `${prefix}_${bytesToBase64Url(randomBytes(32))}`;
}

export async function digestOpaqueToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export async function prehashPassword(
  password: string,
  pepper: string | Uint8Array,
): Promise<string> {
  if (password.length < 12 || password.length > 1_024) {
    throw new RangeError(
      "Password must contain between 12 and 1024 UTF-16 code units",
    );
  }
  return bytesToBase64Url(await hmacBytes(pepper, password));
}

export function generateTotpSecret(): Uint8Array {
  return randomBytes(20);
}

function counterBytes(counter: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = counter;
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

export interface TotpOptions {
  digits?: 6 | 8;
  periodSeconds?: number;
  timestampMs?: number;
}

export async function generateTotpCode(
  secret: Uint8Array,
  options: TotpOptions = {},
): Promise<string> {
  if (secret.byteLength < 16)
    throw new RangeError("TOTP secret must contain at least 128 bits");
  const digits = options.digits ?? 6;
  const period = options.periodSeconds ?? 30;
  if (!Number.isSafeInteger(period) || period < 1)
    throw new RangeError("TOTP period must be positive");
  const timestamp = options.timestampMs ?? Date.now();
  const counter = BigInt(Math.floor(timestamp / 1_000 / period));
  const digest = await hmacBytes(secret, counterBytes(counter), "SHA-1");
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

export async function verifyTotpCode(
  secret: Uint8Array,
  code: string,
  options: TotpOptions & { window?: number } = {},
): Promise<boolean> {
  const digits = options.digits ?? 6;
  if (!new RegExp(`^[0-9]{${digits}}$`, "u").test(code)) return false;
  const period = options.periodSeconds ?? 30;
  const timestamp = options.timestampMs ?? Date.now();
  const window = options.window ?? 1;
  if (!Number.isSafeInteger(window) || window < 0 || window > 10)
    throw new RangeError("Invalid TOTP window");
  for (let delta = -window; delta <= window; delta += 1) {
    const candidate = await generateTotpCode(secret, {
      digits,
      periodSeconds: period,
      timestampMs: timestamp + delta * period * 1_000,
    });
    const left = utf8(candidate);
    const right = utf8(code);
    let difference = left.length ^ right.length;
    for (
      let index = 0;
      index < Math.max(left.length, right.length);
      index += 1
    ) {
      difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
    }
    if (difference === 0) return true;
  }
  return false;
}
