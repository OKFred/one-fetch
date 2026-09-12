import type { GatewayHttpRequest } from "@one-fetch/client";

export type ConformanceTier = "smoke" | "limits" | "resilience";

export interface HttpConformanceFixture {
  id: string;
  description: string;
  tier: ConformanceTier;
  request: Omit<GatewayHttpRequest, "targetUrl" | "signal"> & {
    targetPath: string;
  };
  cancelAfterMs?: number;
  expected: {
    status?: number;
    source?: "target" | "relay" | "intermediary";
    errorCode?: string;
    acceptedClientErrors?: string[];
    bodyIncludes?: string[];
    bodyBytes?: number;
    bodyReadError?: boolean;
    incomplete?: {
      relayErrorCodes: string[];
    };
    setCookie?: string[];
    serverTimingNames?: string[];
    targetHeaders?: Array<{ name: string; value: string }>;
  };
}

const binary = new Uint8Array([0, 1, 2, 127, 128, 255]);
const jsonBody = JSON.stringify({ hello: "one-fetch", count: 2 });
const formBody = "name=one-fetch&tag=one&tag=two";
const multipartBoundary = "one-fetch-conformance-boundary";
const multipartBody = [
  `--${multipartBoundary}`,
  'Content-Disposition: form-data; name="note"',
  "",
  "conformance",
  `--${multipartBoundary}`,
  'Content-Disposition: form-data; name="file"; filename="sample.txt"',
  "Content-Type: text/plain",
  "X-Part-Fixture: retained",
  "",
  "fixture-file",
  `--${multipartBoundary}--`,
  "",
].join("\r\n");

export const HTTP_CONFORMANCE_FIXTURES: readonly HttpConformanceFixture[] =
  Object.freeze([
    {
      id: "arbitrary-v1-path-and-duplicate-query",
      description:
        "The Gateway does not reserve /v1 and preserves duplicate query values",
      tier: "smoke",
      request: {
        targetPath: "/v1/echo?tag=one&tag=two&empty=",
        method: "POST",
        headers: [
          { name: "Content-Type", value: "application/octet-stream" },
          { name: "X-Conformance", value: "first" },
          { name: "X-Conformance", value: "second" },
        ],
        body: binary,
        bodySizeBytes: binary.byteLength,
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: {
        status: 200,
        source: "target",
        bodyIncludes: [
          '"path":"/v1/echo"',
          '"rawQuery":"tag=one&tag=two&empty="',
          '"bodyBase64":"AAECf4D/"',
          "x-conformance",
        ],
      },
    },
    {
      id: "leading-slashes-stay-in-target-path",
      description:
        "Leading slashes are literal path segments, not a replacement target host",
      tier: "smoke",
      request: {
        targetPath: "//v1/echo?tag=one&tag=two&escaped=%2f",
        method: "GET",
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: {
        status: 404,
        source: "target",
        bodyIncludes: [
          '"path":"//v1/echo"',
          '"rawQuery":"tag=one&tag=two&escaped=%2f"',
        ],
      },
    },
    {
      id: "json-request-body",
      description: "JSON content type and bytes reach the target",
      tier: "smoke",
      request: {
        targetPath: "/echo",
        method: "POST",
        headers: [{ name: "Content-Type", value: "application/json" }],
        body: jsonBody,
        bodySizeBytes: new TextEncoder().encode(jsonBody).byteLength,
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: {
        status: 200,
        source: "target",
        bodyIncludes: ['"method":"POST"', '"contentType":"application/json"'],
      },
    },
    {
      id: "urlencoded-request-body",
      description: "URL-encoded request bytes remain intact",
      tier: "smoke",
      request: {
        targetPath: "/echo",
        method: "POST",
        headers: [
          {
            name: "Content-Type",
            value: "application/x-www-form-urlencoded",
          },
        ],
        body: formBody,
        bodySizeBytes: new TextEncoder().encode(formBody).byteLength,
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: {
        status: 200,
        source: "target",
        bodyIncludes: [
          '"contentType":"application/x-www-form-urlencoded"',
          '"bodyBase64":"bmFtZT1vbmUtZmV0Y2gmdGFnPW9uZSZ0YWc9dHdv"',
        ],
      },
    },
    {
      id: "multipart-request-body",
      description: "Multipart boundaries, filenames, and part headers survive",
      tier: "smoke",
      request: {
        targetPath: "/echo",
        method: "POST",
        headers: [
          {
            name: "Content-Type",
            value: `multipart/form-data; boundary=${multipartBoundary}`,
          },
        ],
        body: multipartBody,
        bodySizeBytes: new TextEncoder().encode(multipartBody).byteLength,
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: {
        status: 200,
        source: "target",
        bodyIncludes: ["multipart/form-data", "bodyBase64"],
      },
    },
    ...[401, 429, 503].map(
      (status): HttpConformanceFixture => ({
        id: `target-${status}-is-not-relay-failure`,
        description: `A signed target ${status} remains a target result`,
        tier: "smoke",
        request: {
          targetPath: `/status/${status}`,
          method: "GET",
          fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
        },
        expected: {
          status,
          source: "target",
          bodyIncludes: [`target-status-${status}`],
        },
      }),
    ),
    {
      id: "manual-redirect-is-a-target-result",
      description: "Manual redirects preserve the first target response",
      tier: "smoke",
      request: {
        targetPath: "/redirect?to=%2Fecho%3Fredirected%3D1",
        method: "GET",
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: {
        status: 302,
        source: "target",
        targetHeaders: [{ name: "location", value: "/echo?redirected=1" }],
      },
    },
    {
      id: "repeated-set-cookie-metadata",
      description:
        "Repeated Set-Cookie values are delivered as metadata, not Gateway cookies",
      tier: "smoke",
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
      tier: "smoke",
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
    {
      id: "streaming-response",
      description: "A multi-chunk response is streamed to completion",
      tier: "smoke",
      request: {
        targetPath: "/bytes/65536?chunk=4096",
        method: "GET",
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: { status: 200, source: "target", bodyBytes: 65_536 },
    },
  ]);

export const HTTP_LIMIT_FIXTURES: readonly HttpConformanceFixture[] =
  Object.freeze([
    {
      id: "response-limit-20-mib",
      description: "The documented 20 MiB response boundary succeeds",
      tier: "limits",
      request: {
        targetPath: "/bytes/20971520",
        method: "GET",
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: { status: 200, source: "target", bodyBytes: 20_971_520 },
    },
    {
      id: "response-limit-20-mib-plus-one",
      description: "A response one byte over the limit is never accepted",
      tier: "limits",
      request: {
        targetPath: "/bytes/20971521",
        method: "GET",
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: {
        incomplete: { relayErrorCodes: ["response_too_large"] },
        acceptedClientErrors: ["TypeError", "Error"],
      },
    },
  ]);

export const HTTP_RESILIENCE_FIXTURES: readonly HttpConformanceFixture[] =
  Object.freeze([
    {
      id: "timeout",
      description: "The shorter request timeout interrupts a slow target",
      tier: "resilience",
      request: {
        targetPath: "/delay/500",
        method: "GET",
        fetchOptions: { redirect: "manual", timeoutMs: 100 },
      },
      expected: {
        errorCode: "timeout",
        acceptedClientErrors: ["TimeoutError", "AbortError", "Error"],
      },
    },
    {
      id: "cancellation",
      description: "Client cancellation interrupts a slow target",
      tier: "resilience",
      cancelAfterMs: 25,
      request: {
        targetPath: "/delay/5000",
        method: "GET",
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: {
        errorCode: "cancelled",
        acceptedClientErrors: ["AbortError", "Error"],
      },
    },
    {
      id: "truncated-response",
      description: "A target body failure is not reported as complete",
      tier: "resilience",
      request: {
        targetPath: "/truncated",
        method: "GET",
        fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
      },
      expected: {
        source: "target",
        incomplete: { relayErrorCodes: [] },
        acceptedClientErrors: ["TypeError", "Error"],
      },
    },
  ]);

export const ALL_HTTP_CONFORMANCE_FIXTURES: readonly HttpConformanceFixture[] =
  Object.freeze([
    ...HTTP_CONFORMANCE_FIXTURES,
    ...HTTP_LIMIT_FIXTURES,
    ...HTTP_RESILIENCE_FIXTURES,
  ]);
