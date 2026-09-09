import { OneFetchCapabilitiesV1Schema } from "@one-fetch/protocol";
import { describe, expect, it } from "vitest";

import {
  AcceptanceReportV1Schema,
  assertReportDoesNotContain,
  createAcceptanceReport,
} from "../src/index.js";

const capabilities = OneFetchCapabilitiesV1Schema.parse({
  protocolVersion: 1,
  instanceId: "instance-1",
  provider: "node",
  buildVersion: "0.1.0",
  controlGatewayPairId: "pair-1",
  configVersion: "config-1",
  configUpdatedAt: "2026-09-04T00:00:00.000Z",
  policyMode: "allowlist",
  transports: {
    http: { state: "stable" },
    websocket: { state: "unsupported" },
    tcp: { state: "unsupported" },
    tls: { state: "unsupported" },
  },
  limits: {
    metadataBytes: 49_152,
    requestBodyBytes: 20_971_520,
    responseBodyBytes: 20_971_520,
    inspectableBodyBytes: 1_048_576,
    timeoutMs: 60_000,
    redirects: 20,
  },
  fetchOptions: [],
  headerMutations: [],
  audit: { state: "healthy" },
});

describe("AcceptanceReportV1", () => {
  it("records only bounded execution evidence", async () => {
    const report = await createAcceptanceReport({
      commit: "a".repeat(40),
      capabilities,
      controlUrl: "https://control.example",
      gatewayUrl: "https://gateway.example",
      targetUrl: "https://target.example",
      suite: {
        passed: true,
        results: [
          {
            id: "target-503",
            passed: true,
            failures: [],
            durationMs: 12,
            skipped: "fixture transport cannot express this failure",
            observed: { source: "target", status: 503, responseBytes: 3 },
          },
        ],
      },
    });

    expect(AcceptanceReportV1Schema.parse(report)).toEqual(report);
    expect(report.capabilitiesSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(report)).not.toContain("target response body");
  });

  it("fails closed when a supplied secret canary reaches the report", async () => {
    const report = await createAcceptanceReport({
      commit: "b".repeat(40),
      capabilities,
      controlUrl: "https://control.example",
      gatewayUrl: "https://gateway.example",
      targetUrl: "https://target.example",
      suite: {
        passed: false,
        results: [
          {
            id: "failure",
            passed: false,
            failures: ["leaked-secret-canary"],
            durationMs: 1,
          },
        ],
      },
    });

    expect(() =>
      assertReportDoesNotContain(report, ["leaked-secret-canary"]),
    ).toThrow("forbidden secret");
  });
});
