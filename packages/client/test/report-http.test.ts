import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createSignedResponseMetadata } from "@one-fetch/core";
import {
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  decodeRequestMetadata,
  encodeResponseMetadata,
  type ExecutionReportV1,
} from "@one-fetch/protocol";
import { OneFetchExecutionError, OneFetchGatewayClient } from "../src/index.js";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("execution report watcher over real local HTTP", () => {
  it.each(["partial", "timeout"] as const)(
    "aborts a live socket after an authenticated %s report",
    async (outcome) => {
      const token = "of_synthetic_local_http_report_secret";
      let report: ExecutionReportV1 | undefined;
      let disconnected = false;
      let reportCalls = 0;
      let targetResponse: ServerResponse | undefined;
      const failures: string[] = [];
      const control = createServer((request, response) => {
        reportCalls += 1;
        if (
          request.url !== "/api/v1/reports/local-report" ||
          request.headers.authorization !== `Bearer ${token}` ||
          request.headers.cookie ||
          request.headers[ONE_FETCH_REQUEST_HEADER.toLowerCase()]
        ) {
          failures.push("unexpected Control credentials or URL");
          response.writeHead(403).end();
          return;
        }
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(report));
      });
      const gateway = createServer((request, response) => {
        targetResponse = response;
        response.on("close", () => {
          disconnected = true;
        });
        const handle = async (): Promise<void> => {
          const raw = request.headers[ONE_FETCH_REQUEST_HEADER.toLowerCase()];
          if (typeof raw !== "string") throw new Error("Missing metadata");
          const metadata = decodeRequestMetadata(raw);
          report = {
            schemaVersion: 1,
            reportId: "local-report",
            requestId: metadata.requestId,
            status: 503,
            outcome,
            source: outcome === "partial" ? "target" : "relay",
            bodyComplete: false,
            responseBytes: 3,
            problem: {
              code: outcome === "partial" ? "response_too_large" : "timeout",
              origin: "adapter",
              stage: "upstream-body",
              message: "synthetic terminal report",
              retryable: false,
            },
            timing: { phases: [], serverTiming: [] },
            finishedAt: new Date().toISOString(),
            auditState: "recorded",
          };
          const signed = await createSignedResponseMetadata(
            {
              protocolVersion: 1,
              requestId: metadata.requestId,
              nonce: metadata.nonce,
              outcome: "target",
              target: {
                kind: "http",
                status: 503,
                statusText: "Fixture",
                headers: [],
                setCookie: [],
                bodyComplete: false,
              },
              timing: { phases: [], serverTiming: [] },
              configVersionUsed: "v1",
              mutations: [],
              audit: { state: "recorded" },
              reportId: "local-report",
            },
            token,
          );
          response.writeHead(503, {
            "Content-Type": "application/octet-stream",
            [ONE_FETCH_RESPONSE_HEADER]: encodeResponseMetadata(signed),
          });
          response.write("abc"); // Intentionally never end: models the observed hosted response hang.
        };
        void handle().catch(() => {
          failures.push("fixture handler failed");
          response.destroy();
        });
      });
      const controlUrl = await listen(control);
      const gatewayUrl = await listen(gateway);
      try {
        const client = new OneFetchGatewayClient({
          gatewayUrl,
          token,
          executionReports: { controlUrl },
        });
        const result = await client.executeHttp({
          method: "GET",
          targetUrl: "https://synthetic.example/data",
          fetchOptions: { timeoutMs: 5_000 },
        });
        const reader = result.response.body!.getReader();
        const started = performance.now();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(
          "abc",
        );
        const error: unknown = await reader
          .read()
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(OneFetchExecutionError);
        expect(error).toMatchObject({
          report: { outcome, bodyComplete: false },
        });
        expect(performance.now() - started).toBeLessThan(3_000);
        expect(result.classification.source).toBe("target");
        expect(result.response.status).toBe(503);
        await expect.poll(() => disconnected, { timeout: 1_000 }).toBe(true);
        expect(reportCalls).toBe(1);
        expect(failures).toEqual([]);
      } finally {
        targetResponse?.destroy();
        await Promise.all([close(gateway), close(control)]);
      }
    },
  );
});
