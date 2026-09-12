import { describe, expect, it } from "vitest";
import {
  assertOriginalPath,
  restoreSupabaseIngressPath,
} from "../src/ingress-path.js";

describe("Supabase ingress path binding", () => {
  it.each([
    ["//v1/echo?a=%2f&a=2", "/v1/echo?a=%2F&a=2"],
    ["//v1/echo?a=%2f", "//v1/echo?a=%2F"],
    ["/a//b///c?q=https://example.test//x", "/a/b/c?q=https://example.test//x"],
    ["/%2f?q=%5c", "/%2F?q=%5C"],
    [
      "/echo?q=hello%20world&q=hello+world",
      "/echo?q=hello%20world&q=hello+world",
    ],
  ])("restores only the original bytes: %s", (original, observed) => {
    expect(restoreSupabaseIngressPath(original, observed)).toBe(original);
  });
  it.each([
    "https://evil.test/a",
    "a",
    "/a#b",
    "/a\\b",
    "/a\nb",
    "/a b",
    "/a/../b",
    "/%2e/b",
    "/a%zz",
    "/a?",
    "/中文",
    123,
    {},
    "/".repeat(49_153),
  ])("rejects invalid origin-form values", (value) =>
    expect(() => assertOriginalPath(value)).toThrow(),
  );
  it.each([
    ["/a?x=1&x=2", "/a?x=2&x=1"],
    ["/a?x=%2f", "/a?x=/"],
    ["/a//b", "/other"],
    ["/a?x=//", "/a?x=/"],
    ["/%41", "/A"],
    ["/a", "//a"],
    ["/a", "/a?extra=1"],
    ["/echo?q=hello%20world", "/echo?q=hello+world"],
    ["/echo?q=hello+world", "/echo?q=hello%20world"],
    ["/echo?q=%2b", "/echo?q=+"],
  ])("rejects unknown ingress changes", (original, observed) => {
    expect(() => restoreSupabaseIngressPath(original, observed)).toThrow();
  });
  it("keeps repeated query order and escape spelling across generated slash runs", () => {
    for (let a = 1; a <= 20; a += 1)
      for (let b = 1; b <= 20; b += 1) {
        const original = `${"/".repeat(a)}v1${"/".repeat(b)}echo?x=%2f&x=//&x=%2F`;
        expect(
          restoreSupabaseIngressPath(original, "/v1/echo?x=%2F&x=//&x=%2F"),
        ).toBe(original);
      }
  });
});
