import { describe, expect, it } from "vitest";

import {
  ONE_FETCH_LIMITS_V1,
  OneFetchRequestMetaV1Schema,
  OneFetchResponseMetaV1Schema,
  ProtocolCodecError,
  createTunnelClientHello,
  decodedMetadataByteLength,
  decodeTunnelClientHello,
  encodeTunnelClientHello,
  decodeRequestMetadata,
  encodeRequestMetadata,
} from "../src/index.js";

const request = {
  protocolVersion: 1 as const,
  requestId: "request-1",
  nonce: "0123456789abcdef0123456789abcdef",
  transport: "http" as const,
  targetOrigin: "https://example.com",
  targetHeaders: [
    { name: "X-Duplicate", value: "one" },
    { name: "X-Duplicate", value: "two" },
  ],
  fetchOptions: { redirect: "manual" as const, timeoutMs: 60_000 },
  body: { sizeBytes: 0 },
  hop: 0,
};

describe("protocol metadata", () => {
  it("round-trips strict request metadata and preserves repeated headers", () => {
    const encoded = encodeRequestMetadata(request);
    expect(decodeRequestMetadata(encoded)).toEqual(request);
    expect(decodedMetadataByteLength(encoded)).toBe(
      new TextEncoder().encode(JSON.stringify(request)).byteLength,
    );
  });

  it("measures the decoded metadata budget instead of Base64URL overhead", () => {
    const encoded = encodeRequestMetadata({
      ...request,
      targetHeaders: Array.from({ length: 3 }, (_, index) => ({
        name: `X-Large-${index}`,
        value: "x".repeat(13_000),
      })),
    });
    expect(new TextEncoder().encode(encoded).byteLength).toBeGreaterThan(
      ONE_FETCH_LIMITS_V1.metadataBytes,
    );
    expect(decodedMetadataByteLength(encoded)).toBeLessThanOrEqual(
      ONE_FETCH_LIMITS_V1.metadataBytes,
    );
  });

  it("rejects unknown fields", () => {
    expect(
      OneFetchRequestMetaV1Schema.safeParse({ ...request, unexpected: true })
        .success,
    ).toBe(false);
  });

  it("rejects CRLF header injection", () => {
    const poisoned = {
      ...request,
      targetHeaders: [{ name: "X-Test", value: "ok\r\nInjected: yes" }],
    };
    expect(OneFetchRequestMetaV1Schema.safeParse(poisoned).success).toBe(false);
  });

  it("rejects oversized metadata before JSON parsing", () => {
    const oversized = "eA".repeat(ONE_FETCH_LIMITS_V1.metadataBytes);
    expect(() => decodeRequestMetadata(oversized)).toThrowError(
      ProtocolCodecError,
    );
  });

  it("represents tunnel results without inventing an HTTP status", () => {
    const result = OneFetchResponseMetaV1Schema.safeParse({
      protocolVersion: 1,
      requestId: "tunnel-1",
      nonce: "0123456789abcdef0123456789abcdef",
      outcome: "target",
      target: {
        kind: "tunnel",
        transport: "websocket",
        state: "established",
        selectedSubprotocol: "graphql-ws",
      },
      timing: { phases: [], serverTiming: [] },
      configVersionUsed: "v1",
      mutations: [],
      audit: { state: "recorded" },
      signature: "valid_signature_shape",
    });
    expect(result.success).toBe(true);
  });

  it("carries browser tunnel authentication in the first frame", () => {
    const tunnelRequest = {
      ...request,
      transport: "websocket" as const,
    };
    const hello = createTunnelClientHello(
      tunnelRequest,
      "of_tunnel_token_long_enough",
    );
    expect(decodeTunnelClientHello(encodeTunnelClientHello(hello))).toEqual(
      hello,
    );
  });
});
