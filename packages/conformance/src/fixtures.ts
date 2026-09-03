import type { GatewayHttpRequest } from "@one-fetch/client";

export interface HttpConformanceFixture {
  id: string;
  description: string;
  request: Omit<GatewayHttpRequest, "targetUrl"> & { targetPath: string };
  expected: {
    status: number;
    source: "target";
    bodyIncludes?: string[];
    setCookie?: string[];
    serverTimingNames?: string[];
  };
}

export const HTTP_CONFORMANCE_FIXTURES: readonly HttpConformanceFixture[] =
  Object.freeze([
    {
      id: "arbitrary-v1-path-and-duplicate-query",
      description:
        "The Gateway does not reserve /v1 and preserves duplicate query values",
      request: {
        targetPath: "/v1/echo?tag=one&tag=two&empty=",
        method: "POST",
        headers: [
          { name: "Content-Type", value: "application/octet-stream" },
          { name: "X-Conformance", value: "first" },
          { name: "X-Conformance", value: "second" },
        ],
        body: new Uint8Array([0, 1, 2, 127, 128, 255]),
        bodySizeBytes: 6,
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: {
        status: 200,
        source: "target",
        bodyIncludes: ["/v1/echo", "tag=one", "tag=two", "AAECf4D/"],
      },
    },
    {
      id: "target-503-is-not-relay-failure",
      description: "A signed target 5xx remains a target result",
      request: {
        targetPath: "/status/503",
        method: "GET",
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: {
        status: 503,
        source: "target",
        bodyIncludes: ["target-status-503"],
      },
    },
    {
      id: "repeated-set-cookie-metadata",
      description:
        "Repeated Set-Cookie values are delivered as metadata, not Gateway cookies",
      request: {
        targetPath: "/set-cookie",
        method: "GET",
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: {
        status: 200,
        source: "target",
        setCookie: [
          "alpha=1; Path=/; Secure",
          "beta=2; Path=/; HttpOnly; Secure",
        ],
      },
    },
    {
      id: "server-timing-preserved",
      description:
        "Target Server-Timing is preserved separately from Gateway timing",
      request: {
        targetPath: "/server-timing",
        method: "GET",
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: {
        status: 200,
        source: "target",
        serverTimingNames: ["db", "app"],
      },
    },
  ]);
