import { describe, expect, it } from "vitest";

import { IncrementalSha256 } from "../src/index.js";

describe("incremental SHA-256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "The quick brown fox jumps over the lazy dog",
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    ],
  ])("hashes %j", (value, expected) => {
    const bytes = new TextEncoder().encode(value);
    const hash = new IncrementalSha256();
    for (let offset = 0; offset < bytes.length; offset += 3) {
      hash.update(bytes.subarray(offset, offset + 3));
    }
    expect(hash.digestHex()).toBe(expected);
  });
});
