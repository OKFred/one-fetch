import { describe, expect, it } from "vitest";

import { OneFetchGatewayClient } from "@one-fetch/client";
import { createSignedResponseMetadata } from "@one-fetch/core";
import {
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  decodeRequestMetadata,
  encodeResponseMetadata,
  type HeaderEntryV1,
  type OneFetchTimingV1,
  type OneFetchUnsignedResponseMetaV1,
} from "@one-fetch/protocol";

import {
  handleConformanceTarget,
  HTTP_RESILIENCE_FIXTURES,
  parseServerTiming,
  runGatewayConformance,
} from "../src/index.js";

const TOKEN = "of_conformance_token_that_is_long_enough";

function getSetCookie(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (extended.getSetCookie !== undefined) return extended.getSetCookie();
  const combined = headers.get("Set-Cookie");
  return combined === null ? [] : combined.split(/,\s*(?=[^;,]+=)/u);
}

function targetHeaders(headers: Headers): HeaderEntryV1[] {
  return Array.from(headers.entries())
    .filter(([name]) => name.toLowerCase() !== "set-cookie")
    .map(([name, value]) => ({ name, value }));
}

function inMemoryGatewayFetch(): typeof fetch {
  return async (input, init) => {
    const gatewayRequest = new Request(input, init);
    const encoded = gatewayRequest.headers.get(ONE_FETCH_REQUEST_HEADER);
    if (encoded === null)
      return new Response("missing metadata", { status: 400 });
    const metadata = decodeRequestMetadata(encoded);
    const gatewayUrl = new URL(gatewayRequest.url);
    const targetUrl = new URL(
      `${metadata.targetOrigin}${gatewayUrl.pathname}${gatewayUrl.search}`,
    );
    const upstream = new Request(targetUrl, {
      method: gatewayRequest.method,
      headers: metadata.targetHeaders.map(({ name, value }) => [name, value]),
      ...(gatewayRequest.body === null
        ? {}
        : { body: gatewayRequest.body, duplex: "half" }),
    });
    const startedAt = performance.now();
    const target = await handleConformanceTarget(upstream);
    const incomplete = targetUrl.pathname === "/truncated";
    const serverTiming = parseServerTiming(target.headers.get("Server-Timing"));
    const timing: OneFetchTimingV1 = {
      phases: [
        {
          name: "upstream",
          state: "measured",
          source: "gateway",
          durationMs: performance.now() - startedAt,
        },
      ],
      serverTiming,
    };
    const unsigned: OneFetchUnsignedResponseMetaV1 = {
      protocolVersion: 1,
      requestId: metadata.requestId,
      nonce: metadata.nonce,
      outcome: "target",
      target: {
        kind: "http",
        status: target.status,
        statusText: target.statusText,
        headers: targetHeaders(target.headers),
        setCookie: getSetCookie(target.headers),
        bodyComplete: !incomplete,
      },
      timing,
      configVersionUsed: "conformance-v1",
      mutations: [],
      audit: { state: "recorded" },
      ...(incomplete ? { reportId: "report-truncated" } : {}),
    };
    const signed = await createSignedResponseMetadata(unsigned, TOKEN);
    const outerHeaders = new Headers({
      [ONE_FETCH_RESPONSE_HEADER]: encodeResponseMetadata(signed),
    });
    outerHeaders.append("Set-Cookie", "__cf_bm=vendor; Path=/; HttpOnly");
    return new Response(target.body, {
      status: target.status,
      statusText: target.statusText,
      headers: outerHeaders,
    });
  };
}

describe("portable Gateway conformance suite", () => {
  it("passes against the in-memory reference adapter", async () => {
    const client = new OneFetchGatewayClient({
      gatewayUrl: "https://gateway.test",
      token: TOKEN,
      fetch: inMemoryGatewayFetch(),
    });
    const report = await runGatewayConformance(client, "https://target.test");
    expect(report, JSON.stringify(report.results, null, 2)).toMatchObject({
      passed: true,
    });
    expect(
      report.results.find(
        ({ id }) => id === "leading-slashes-stay-in-target-path",
      ),
    ).toMatchObject({
      passed: true,
      observed: { source: "target", status: 404 },
    });
  });

  it("parses quoted Server-Timing descriptions without splitting commas", () => {
    expect(
      parseServerTiming('db;dur=1.5;desc="primary, replica", app;dur=2'),
    ).toEqual([
      { name: "db", durationMs: 1.5, description: "primary, replica" },
      { name: "app", durationMs: 2 },
    ]);
  });

  it("uses the terminal report when a client cannot observe a partial body", async () => {
    const client = new OneFetchGatewayClient({
      gatewayUrl: "https://gateway.test",
      token: TOKEN,
      fetch: inMemoryGatewayFetch(),
    });
    const fixture = HTTP_RESILIENCE_FIXTURES.find(
      ({ id }) => id === "truncated-response",
    );
    expect(fixture).toBeDefined();
    const report = await runGatewayConformance(
      client,
      "https://target.test",
      [fixture!],
      {
        getExecutionReport: () =>
          Promise.resolve({
            schemaVersion: 1,
            reportId: "report-truncated",
            requestId: "request-truncated",
            outcome: "partial",
            source: "target",
            status: 200,
            responseBytes: 7,
            bodyComplete: false,
            finishedAt: new Date().toISOString(),
            auditState: "recorded",
            timing: { phases: [], serverTiming: [] },
          }),
      },
    );
    expect(report.results[0]).toMatchObject({
      passed: true,
      observed: { reportOutcome: "partial", bodyComplete: false },
    });
  });

  it("records an explicit platform skip without executing the fixture", async () => {
    const fixture = HTTP_RESILIENCE_FIXTURES.find(
      ({ id }) => id === "truncated-response",
    );
    expect(fixture).toBeDefined();
    const report = await runGatewayConformance(
      {} as OneFetchGatewayClient,
      "https://target.test",
      [fixture!],
      { skipFixtures: { "truncated-response": "not expressible" } },
    );
    expect(report).toEqual({
      passed: true,
      results: [
        {
          id: "truncated-response",
          passed: true,
          failures: [],
          durationMs: 0,
          skipped: "not expressible",
        },
      ],
    });
  });

  it("makes unknown fixture routes diagnosable without echoing headers or body", async () => {
    const response = await handleConformanceTarget(
      new Request("https://target.test/unknown?trace=one", {
        method: "POST",
        headers: { Authorization: "fixture-secret" },
        body: "private-body",
      }),
    );
    expect(response.status).toBe(404);
    const payload = (await response.json()) as unknown;
    expect(payload).toEqual({
      error: "fixture-not-found",
      method: "POST",
      path: "/unknown",
      rawQuery: "trace=one",
    });
    expect(JSON.stringify(payload)).not.toContain("fixture-secret");
    expect(JSON.stringify(payload)).not.toContain("private-body");
  });
});
