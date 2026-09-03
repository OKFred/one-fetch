import { describe, expect, it } from "vitest";

import { OneFetchControlClient } from "@one-fetch/client";

import {
  runControlConformance,
  validateControlErrorResponse,
} from "../src/index.js";

const INSTANCE_ID = "instance-1";
const PAIR_ID = "pair-1";
const CONFIG_VERSION = "20260904T000000.000Z-4-deadbeef";
const ADMIN_TOKEN = "admin_access_token_that_is_long_enough";
const EXECUTION_TOKEN = "execution_token_that_is_long_enough";

const configuration = {
  schemaVersion: 1,
  instanceId: INSTANCE_ID,
  controlGatewayPairId: PAIR_ID,
  revision: 4,
  version: CONFIG_VERSION,
  updatedAt: "2026-09-04T00:00:00.000Z",
  gatewayPaused: false,
  policy: { schemaVersion: 1, mode: "allowlist", revision: 3, rules: [] },
};

const capabilities = {
  protocolVersion: 1,
  instanceId: INSTANCE_ID,
  provider: "node",
  buildVersion: "0.1.0",
  controlGatewayPairId: PAIR_ID,
  configVersion: CONFIG_VERSION,
  configUpdatedAt: "2026-09-04T00:00:00.000Z",
  policyMode: "allowlist",
  transports: {
    http: { state: "stable" },
    websocket: { state: "experimental" },
    tcp: { state: "experimental" },
    tls: { state: "experimental" },
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
};

function referenceControlFetch(): {
  fetch: typeof fetch;
  reportAuthorization: () => string | null;
} {
  let reportAuthorization: string | null = null;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const protectedRoute = ![
      "/api/v1/capabilities",
      "/api/v1/bootstrap",
      "/api/v1/features",
    ].includes(url.pathname);
    if (protectedRoute && url.pathname.startsWith("/api/v1/reports/")) {
      reportAuthorization = request.headers.get("Authorization");
    } else if (
      protectedRoute &&
      request.headers.get("Authorization") !== `Bearer ${ADMIN_TOKEN}`
    ) {
      return Promise.resolve(
        Response.json(
          { error: { code: "unauthorized", message: "Unauthorized" } },
          { status: 401 },
        ),
      );
    }

    switch (url.pathname) {
      case "/api/v1/capabilities":
        return Promise.resolve(Response.json(capabilities));
      case "/api/v1/bootstrap":
        return Promise.resolve(
          Response.json({
            schemaVersion: 1,
            initialized: true,
            instanceId: INSTANCE_ID,
          }),
        );
      case "/api/v1/features":
        return Promise.resolve(
          Response.json({
            schemaVersion: 1,
            features: [
              {
                schemaVersion: 1,
                feature: "alerts",
                state: "unsupported",
                reason: "Not available in the reference adapter",
              },
              {
                schemaVersion: 1,
                feature: "backups",
                state: "unsupported",
                reason: "Not available in the reference adapter",
              },
            ],
          }),
        );
      case "/api/v1/config":
        return Promise.resolve(Response.json(configuration));
      case "/api/v1/tokens/execution":
        return Promise.resolve(Response.json({ schemaVersion: 1, tokens: [] }));
      case "/api/v1/audit":
        return Promise.resolve(Response.json({ schemaVersion: 1, events: [] }));
      case "/api/v1/alerts":
        return Promise.resolve(
          Response.json({
            schemaVersion: 1,
            feature: "alerts",
            state: "unsupported",
            reason: "Not available in the reference adapter",
          }),
        );
      case "/api/v1/backups":
        return Promise.resolve(
          Response.json({
            schemaVersion: 1,
            feature: "backups",
            state: "unsupported",
            reason: "Not available in the reference adapter",
          }),
        );
      case "/api/v1/reports/report-1":
        return Promise.resolve(
          Response.json({
            schemaVersion: 1,
            reportId: "report-1",
            requestId: "request-1",
            outcome: "completed",
            source: "target",
            status: 200,
            responseBytes: 2,
            bodyComplete: true,
            timing: { phases: [], serverTiming: [] },
            finishedAt: "2026-09-04T00:00:01.000Z",
            auditState: "recorded",
          }),
        );
      default:
        return Promise.resolve(
          Response.json(
            { error: { code: "not_found", message: "Not found" } },
            { status: 404 },
          ),
        );
    }
  };
  return { fetch, reportAuthorization: () => reportAuthorization };
}

describe("portable Control conformance suite", () => {
  it("validates public, administrator, and owned-report contracts", async () => {
    const reference = referenceControlFetch();
    const client = new OneFetchControlClient({
      controlUrl: "https://control.test",
      accessToken: ADMIN_TOKEN,
      fetch: reference.fetch,
    });
    const report = await runControlConformance(client, {
      includeManagement: true,
      expectedInstanceId: INSTANCE_ID,
      executionReport: {
        reportId: "report-1",
        executionToken: EXECUTION_TOKEN,
        expectedRequestId: "request-1",
      },
    });
    expect(report, JSON.stringify(report.results, null, 2)).toMatchObject({
      passed: true,
    });
    expect(reference.reportAuthorization()).toBe(`Bearer ${EXECUTION_TOKEN}`);
  });

  it("flags a configuration that does not belong to the advertised instance", async () => {
    const reference = referenceControlFetch();
    const baseFetch = reference.fetch;
    const client = new OneFetchControlClient({
      controlUrl: "https://control.test",
      accessToken: ADMIN_TOKEN,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === "/api/v1/config")
          return Response.json({ ...configuration, instanceId: "wrong" });
        return baseFetch(input, init);
      },
    });
    const report = await runControlConformance(client, {
      includeManagement: true,
    });
    expect(report.passed).toBe(false);
    expect(
      report.results.find(({ id }) => id === "control-runtime-configuration"),
    ).toMatchObject({ passed: false });
  });

  it("requires nested JSON for failed Control responses", async () => {
    await expect(
      validateControlErrorResponse(
        Response.json(
          { error: { code: "forbidden", message: "Forbidden" } },
          { status: 403 },
        ),
      ),
    ).resolves.toEqual([]);
    await expect(
      validateControlErrorResponse(
        Response.json(
          { code: "forbidden", message: "Forbidden" },
          { status: 403 },
        ),
      ),
    ).resolves.toContain("response is not a canonical Control error");
  });
});
