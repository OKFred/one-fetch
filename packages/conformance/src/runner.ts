import type { OneFetchGatewayClient } from "@one-fetch/client";

import {
  HTTP_CONFORMANCE_FIXTURES,
  type HttpConformanceFixture,
} from "./fixtures.js";

export interface ConformanceCaseResult {
  id: string;
  passed: boolean;
  failures: string[];
}

export interface ConformanceReport {
  passed: boolean;
  results: ConformanceCaseResult[];
}

function targetUrl(origin: string, path: string): string {
  const target = new URL(origin);
  if (target.pathname !== "/" || target.search !== "" || target.hash !== "") {
    throw new TypeError("Conformance target must be an origin");
  }
  const pathUrl = new URL(path, target);
  return pathUrl.href;
}

async function runCase(
  client: OneFetchGatewayClient,
  origin: string,
  fixture: HttpConformanceFixture,
): Promise<ConformanceCaseResult> {
  const { targetPath, ...request } = fixture.request;
  const failures: string[] = [];
  try {
    const result = await client.executeHttp({
      ...request,
      targetUrl: targetUrl(origin, targetPath),
    });
    if (result.response.status !== fixture.expected.status) {
      failures.push(
        `expected HTTP ${fixture.expected.status}, received ${result.response.status}`,
      );
    }
    if (result.classification.source !== fixture.expected.source) {
      failures.push(
        `expected ${fixture.expected.source} source, received ${result.classification.source}`,
      );
    }
    const body = await result.response.text();
    for (const fragment of fixture.expected.bodyIncludes ?? []) {
      if (!body.includes(fragment))
        failures.push(`response body is missing ${JSON.stringify(fragment)}`);
    }
    if (fixture.expected.setCookie !== undefined) {
      if (
        result.classification.source !== "target" ||
        result.classification.target.kind !== "http"
      ) {
        failures.push("Set-Cookie metadata has no HTTP target envelope");
      } else if (
        JSON.stringify(result.classification.target.setCookie) !==
        JSON.stringify(fixture.expected.setCookie)
      ) {
        failures.push("repeated Set-Cookie metadata was not preserved");
      }
      if (result.response.headers.has("Set-Cookie"))
        failures.push("Gateway emitted target Set-Cookie on its own origin");
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
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  return { id: fixture.id, passed: failures.length === 0, failures };
}

export async function runGatewayConformance(
  client: OneFetchGatewayClient,
  targetOrigin: string,
  fixtures: readonly HttpConformanceFixture[] = HTTP_CONFORMANCE_FIXTURES,
): Promise<ConformanceReport> {
  const results: ConformanceCaseResult[] = [];
  for (const fixture of fixtures)
    results.push(await runCase(client, targetOrigin, fixture));
  return { passed: results.every(({ passed }) => passed), results };
}
