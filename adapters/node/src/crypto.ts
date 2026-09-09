import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const hmacSha256Hex = (key: string, value: string): string =>
  createHmac("sha256", key).update(value, "utf8").digest("hex");

export const randomToken = (bytes = 32): string =>
  randomBytes(bytes).toString("base64url");

export const randomId = (prefix: string): string =>
  `${prefix}_${randomBytes(16).toString("hex")}`;

export const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

export const stableJson = (value: unknown): string => {
  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, visit(nested)]),
      );
    }
    return current;
  };
  return JSON.stringify(visit(value));
};
