import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/types";
import {
  buildUpstreamHeaders,
  getSetCookie,
  outerResponseHeaders,
} from "../src/gateway/headers";
import { evaluatePolicies } from "../src/gateway/policy";

describe("transparent Gateway helpers", () => {
  it("keeps target headers separate and never applies Set-Cookie to the gateway", () => {
    const target = new Headers();
    target.append("Content-Type", "application/json");
    target.append("Set-Cookie", "a=1; Secure");
    const outer = outerResponseHeaders(target);
    expect(outer.get("content-type")).toBe("application/json");
    expect(outer.has("set-cookie")).toBe(false);
    expect(getSetCookie(target)).toEqual(["a=1; Secure"]);
  });

  it("rejects hop-by-hop target request headers", () => {
    expect(() =>
      buildUpstreamHeaders([{ name: "Host", value: "example.com" }]),
    ).toThrow(/cannot be forwarded/u);
  });

  it("denies every target under the default empty allowlist", () => {
    const decision = evaluatePolicies({
      meta: {
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        nonce: "0123456789abcdef0123456789abcdef",
        transport: "http",
        targetOrigin: "https://example.com",
        targetHeaders: [],
        fetchOptions: { redirect: "follow", timeoutMs: 60_000 },
        body: {},
        hop: 0,
      },
      config: structuredClone(DEFAULT_CONFIG),
      method: "GET",
      target: new URL("https://example.com/path?x=1"),
      gatewayPathAndQuery: "/path?x=1",
      body: {
        availability: "available",
        bytes: new Uint8Array(),
        sizeBytes: 0,
      },
      redirectHops: 0,
      crossOrigin: false,
    });
    expect(decision).toMatchObject({ decision: "deny", source: "default" });
  });
});
