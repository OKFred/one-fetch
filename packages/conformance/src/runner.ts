import type { OneFetchGatewayClient } from "@one-fetch/client";
import type { ExecutionReportV1 } from "@one-fetch/protocol";

import {
  HTTP_CONFORMANCE_FIXTURES,
  type HttpConformanceFixture,
} from "./fixtures.js";

export interface ConformanceCaseResult {
  id: string;
  passed: boolean;
  failures: string[];
  durationMs: number;
  skipped?: string;
  observed?: {
    source?: "target" | "relay" | "intermediary" | "client";
    status?: number;
    errorCode?: string;
    responseBytes?: number;
    reportOutcome?: ExecutionReportV1["outcome"];
    bodyComplete?: boolean;
  };
}

export interface ConformanceReport {
  passed: boolean;
  results: ConformanceCaseResult[];
}

export interface ConformanceRunOptions {
  getExecutionReport?: (reportId: string) => Promise<ExecutionReportV1>;
  skipFixtures?: Readonly<Record<string, string>>;
}

function targetUrl(origin: string, path: string): string {
  const target = new URL(origin);
  if (target.pathname !== "/" || target.search !== "" || target.hash !== "") {
    throw new TypeError("Conformance target must be an origin");
  }
  return new URL(path, target).href;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function acceptedClientFailure(
  fixture: HttpConformanceFixture,
  error: unknown,
): boolean {
  return (fixture.expected.acceptedClientErrors ?? []).includes(
    errorName(error),
  );
}

function targetHeaderFailures(
  actual: readonly { name: string; value: string }[],
  expected: readonly { name: string; value: string }[],
): string[] {
  return expected
    .filter(
      (wanted) =>
        !actual.some(
          (entry) =>
            entry.name.toLowerCase() === wanted.name.toLowerCase() &&
            entry.value === wanted.value,
        ),
    )
    .map(({ name }) => `target response metadata is missing ${name}`);
}

async function runCase(
  client: OneFetchGatewayClient,
  origin: string,
  fixture: HttpConformanceFixture,
  options: ConformanceRunOptions,
): Promise<ConformanceCaseResult> {
  const startedAt = performance.now();
  const { targetPath, ...request } = fixture.request;
  const failures: string[] = [];
  const observed: NonNullable<ConformanceCaseResult["observed"]> = {};
  const abort = new AbortController();
  const cancelTimer =
    fixture.cancelAfterMs === undefined
      ? undefined
      : setTimeout(
          () =>
            abort.abort(new DOMException("Cancelled by fixture", "AbortError")),
          fixture.cancelAfterMs,
        );
  try {
    const result = await client.executeHttp({
      ...request,
      signal: abort.signal,
      targetUrl: targetUrl(origin, targetPath),
    });
    observed.status = result.response.status;
    observed.source = result.classification.source;
    if (
      fixture.expected.status !== undefined &&
      result.response.status !== fixture.expected.status
    ) {
      failures.push(
        `expected HTTP ${fixture.expected.status}, received ${result.response.status}`,
      );
    }
    if (
      fixture.expected.source !== undefined &&
      result.classification.source !== fixture.expected.source
    ) {
      failures.push(
        `expected ${fixture.expected.source} source, received ${result.classification.source}`,
      );
    }
    if (result.classification.source === "relay") {
      observed.errorCode = result.classification.error.code;
      if (fixture.expected.incomplete !== undefined) {
        if (
          !fixture.expected.incomplete.relayErrorCodes.includes(
            result.classification.error.code,
          )
        ) {
          failures.push(
            `relay error ${result.classification.error.code} is not an accepted incomplete outcome`,
          );
        }
      } else if (
        fixture.expected.errorCode !== undefined &&
        result.classification.error.code !== fixture.expected.errorCode
      ) {
        failures.push(
          `expected ${fixture.expected.errorCode}, received ${result.classification.error.code}`,
        );
      }
    } else if (fixture.expected.errorCode !== undefined) {
      failures.push(`expected ${fixture.expected.errorCode} relay error`);
    }
    if (
      result.classification.source === "target" &&
      result.classification.target.kind === "http"
    ) {
      if (fixture.expected.setCookie !== undefined) {
        if (
          JSON.stringify(result.classification.target.setCookie) !==
          JSON.stringify(fixture.expected.setCookie)
        ) {
          failures.push("repeated Set-Cookie metadata was not preserved");
        }
        if (result.response.headers.has("Set-Cookie"))
          failures.push("Gateway emitted target Set-Cookie on its own origin");
      }
      failures.push(
        ...targetHeaderFailures(
          result.classification.target.headers,
          fixture.expected.targetHeaders ?? [],
        ),
      );
    }
    if (
      fixture.expected.serverTimingNames !== undefined &&
      result.classification.source === "target"
    ) {
      const names = new Set(
        result.classification.metadata.timing.serverTiming.map(
          ({ name }) => name,
        ),
      );
      for (const name of fixture.expected.serverTimingNames) {
        if (!names.has(name))
          failures.push(`Server-Timing metric ${name} is missing`);
      }
    }
    try {
      const body = new Uint8Array(await result.response.arrayBuffer());
      observed.responseBytes = body.byteLength;
      if (fixture.expected.bodyReadError === true)
        failures.push("expected target body reading to fail");
      if (
        fixture.expected.bodyBytes !== undefined &&
        body.byteLength !== fixture.expected.bodyBytes
      ) {
        failures.push(
          `expected ${fixture.expected.bodyBytes} response bytes, received ${body.byteLength}`,
        );
      }
      if ((fixture.expected.bodyIncludes?.length ?? 0) > 0) {
        const text = new TextDecoder().decode(body);
        for (const fragment of fixture.expected.bodyIncludes ?? []) {
          if (!text.includes(fragment))
            failures.push(
              `response body is missing ${JSON.stringify(fragment)}`,
            );
        }
      }
    } catch (error) {
      observed.source = "client";
      observed.errorCode = errorName(error);
      if (
        fixture.expected.bodyReadError !== true &&
        fixture.expected.incomplete === undefined &&
        !acceptedClientFailure(fixture, error)
      ) {
        failures.push(`response body failed with ${errorName(error)}`);
      }
    }
    if (
      fixture.expected.incomplete !== undefined &&
      result.classification.source === "target"
    ) {
      const reportId = result.classification.metadata.reportId;
      if (reportId === undefined || options.getExecutionReport === undefined) {
        failures.push(
          "target incomplete outcome has no resolvable execution report",
        );
      } else {
        let report: ExecutionReportV1 | undefined;
        for (
          let attempt = 0;
          attempt < 10 && report === undefined;
          attempt += 1
        ) {
          try {
            report = await options.getExecutionReport(reportId);
          } catch {
            if (attempt < 9)
              await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
        }
        if (report === undefined) {
          failures.push("target incomplete execution report was unavailable");
        } else {
          observed.reportOutcome = report.outcome;
          observed.bodyComplete = report.bodyComplete;
          if (report.outcome !== "partial" || report.bodyComplete) {
            failures.push(
              `expected an incomplete target report, received ${report.outcome}/${report.bodyComplete ? "complete" : "incomplete"}`,
            );
          }
        }
      }
    } else if (
      fixture.expected.incomplete !== undefined &&
      result.classification.source !== "relay"
    ) {
      failures.push(
        `incomplete outcome cannot be verified for ${result.classification.source} source`,
      );
    }
  } catch (error) {
    observed.source = "client";
    observed.errorCode = errorName(error);
    if (fixture.expected.incomplete !== undefined) {
      failures.push(
        "request failed before the incomplete outcome could be verified",
      );
    } else if (!acceptedClientFailure(fixture, error)) {
      failures.push(
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      );
    }
  } finally {
    if (cancelTimer !== undefined) clearTimeout(cancelTimer);
  }
  return {
    id: fixture.id,
    passed: failures.length === 0,
    failures,
    durationMs: performance.now() - startedAt,
    observed,
  };
}

export async function runGatewayConformance(
  client: OneFetchGatewayClient,
  targetOrigin: string,
  fixtures: readonly HttpConformanceFixture[] = HTTP_CONFORMANCE_FIXTURES,
  options: ConformanceRunOptions = {},
): Promise<ConformanceReport> {
  const results: ConformanceCaseResult[] = [];
  for (const fixture of fixtures) {
    const reason = options.skipFixtures?.[fixture.id];
    if (reason !== undefined) {
      results.push({
        id: fixture.id,
        passed: true,
        failures: [],
        durationMs: 0,
        skipped: reason,
      });
    } else {
      results.push(await runCase(client, targetOrigin, fixture, options));
    }
  }
  return { passed: results.every(({ passed }) => passed), results };
}
