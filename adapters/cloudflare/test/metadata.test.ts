import { describe, expect, it } from "vitest";

import { metadataExceedsAdapterLimit } from "../src/gateway/metadata";

function encodeBytes(byteLength: number): string {
  return btoa("x".repeat(byteLength))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

describe("Cloudflare metadata budget", () => {
  it("applies the limit to decoded bytes, not Base64URL overhead", () => {
    const atLimit = encodeBytes(49_152);
    expect(atLimit.length).toBeGreaterThan(49_152);
    expect(metadataExceedsAdapterLimit(atLimit, 49_152)).toBe(false);
    expect(metadataExceedsAdapterLimit(encodeBytes(49_153), 49_152)).toBe(true);
  });
});
