import { describe, expect, it } from "vitest";
import { OneFetchGatewayClient } from "@one-fetch/client";
import { createSignedResponseMetadata } from "@one-fetch/core";
import {
  decodeRequestMetadata,
  encodeResponseMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  type ExecutionReportV1,
} from "@one-fetch/protocol";
import { runGatewayConformance } from "../src/runner.js";
import type { HttpConformanceFixture } from "../src/fixtures.js";

const token = "of_local_termination_fixture_execution_token";
const fixture: HttpConformanceFixture = {
  id: "termination",
  description: "synthetic incomplete body",
  tier: "limits",
  request: { targetPath: "/incomplete", method: "GET", requestId: "request-1" },
  expected: { incomplete: { relayErrorCodes: [] } },
};
const report: ExecutionReportV1 = {
  schemaVersion: 1,
  reportId: "report-1",
  requestId: "request-1",
  outcome: "partial",
  source: "target",
  status: 200,
  responseBytes: 1,
  bodyComplete: false,
  finishedAt: "2026-09-13T00:00:00.000Z",
  timing: { phases: [], serverTiming: [] },
  auditState: "recorded",
};

function client() {
  return new OneFetchGatewayClient({
    gatewayUrl: "https://gateway.example",
    token,
    fetch: async (_input, init) => {
      const metadata = decodeRequestMetadata(
        new Headers(init?.headers).get(ONE_FETCH_REQUEST_HEADER)!,
      );
      const signed = await createSignedResponseMetadata(
        {
          protocolVersion: 1,
          requestId: metadata.requestId,
          nonce: metadata.nonce,
          outcome: "target",
          target: {
            kind: "http",
            status: 200,
            statusText: "OK",
            headers: [],
            setCookie: [],
            bodyComplete: false,
          },
          timing: { phases: [], serverTiming: [] },
          configVersionUsed: "v1",
          mutations: [],
          audit: { state: "recorded" },
          reportId: "report-1",
        },
        token,
      );
      return new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(
              () => controller.error(new Error("synthetic incomplete")),
              10,
            );
          },
        }),
        {
          headers: {
            [ONE_FETCH_RESPONSE_HEADER]: encodeResponseMetadata(signed),
          },
        },
      );
    },
  });
}
describe("incomplete response acceptance gate", () => {
  it("does not accept a late partial report as prompt termination", async () => {
    const result = await runGatewayConformance(
      client(),
      "https://target.example",
      [fixture],
      {
        getExecutionReport: () => Promise.resolve(report),
        maximumIncompleteDurationMs: 1,
      },
    );
    expect(result.passed).toBe(false);
    expect(result.results[0]?.observed?.reportOutcome).toBe("partial");
    expect(result.results[0]?.failures).toContain(
      "incomplete response exceeded the 1 ms termination deadline",
    );
  });
  it("accepts a matching partial report within the explicit deadline", async () => {
    const result = await runGatewayConformance(
      client(),
      "https://target.example",
      [fixture],
      {
        getExecutionReport: () => Promise.resolve(report),
        maximumIncompleteDurationMs: 10_000,
      },
    );
    expect(result.passed).toBe(true);
  });
  it.each([
    { requestId: "stale-request" },
    { reportId: "stale-report" },
    { status: 404 },
  ])("rejects a mismatched report: %j", async (patch) => {
    const result = await runGatewayConformance(
      client(),
      "https://target.example",
      [fixture],
      {
        getExecutionReport: () => Promise.resolve({ ...report, ...patch }),
      },
    );
    expect(result.passed).toBe(false);
    expect(result.results[0]?.failures).toContain(
      "incomplete execution report identity does not match the signed target response",
    );
  });
  it.each([0, -1, NaN, Infinity])(
    "rejects invalid deadline %s",
    async (maximumIncompleteDurationMs) => {
      await expect(
        runGatewayConformance(client(), "https://target.example", [], {
          maximumIncompleteDurationMs,
        }),
      ).rejects.toThrow(TypeError);
    },
  );
});
