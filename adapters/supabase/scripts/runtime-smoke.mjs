import console from "node:console";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { OneFetchControlClient, serviceBaseUrl } from "@one-fetch/client";

function option(argumentsList, name) {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchWithTimeout(url, init = {}) {
  const response = await globalThis.fetch(url, {
    ...init,
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  assert(
    response.headers.get("cache-control")?.includes("no-store"),
    `${url} did not disable caching`,
  );
  return response;
}

export async function runRuntimeSmoke(options) {
  const baseUrl = serviceBaseUrl(options.baseUrl, "Supabase Functions URL");
  const controlUrl = `${baseUrl}/one-fetch-control`;
  const gatewayUrl = `${baseUrl}/one-fetch-gateway`;
  const client = new OneFetchControlClient({
    controlUrl,
    fetch: globalThis.fetch,
  });
  const [health, capabilities] = await Promise.all([
    client.getHealth(),
    client.getCapabilities(),
  ]);
  assert(health.service === "one-fetch-control", "Control service ID changed");
  assert(
    health.instanceId === capabilities.instanceId,
    "Control health and capabilities instance IDs differ",
  );
  assert(
    health.instanceId === capabilities.controlGatewayPairId,
    "Control and Gateway pair IDs differ",
  );
  if (options.expectedBuild) {
    assert(
      health.version === options.expectedBuild &&
        capabilities.buildVersion === options.expectedBuild,
      "Runtime build identifier differs from the expected build",
    );
  }

  const openApiResponse = await fetchWithTimeout(
    `${controlUrl}/api/v1/openapi.json`,
  );
  assert(openApiResponse.status === 200, "Runtime OpenAPI request failed");
  const openApi = await openApiResponse.json();
  assert(openApi.openapi === "3.1.0", "Runtime OpenAPI version changed");
  assert(
    openApi.servers?.[0]?.url === controlUrl,
    "Runtime OpenAPI does not advertise the complete Function URL",
  );

  const gatewayResponse = await fetchWithTimeout(`${gatewayUrl}/smoke?probe=1`);
  assert(gatewayResponse.status === 400, "Gateway probe status changed");
  const gatewayProblem = await gatewayResponse.json();
  assert(
    gatewayProblem?.error === "invalid_metadata",
    "Gateway probe did not reach one-fetch protocol validation",
  );
  assert(
    !gatewayResponse.headers.has("one-fetch-response"),
    "Unsigned Gateway probe unexpectedly returned protocol metadata",
  );
  return {
    instanceId: health.instanceId,
    buildVersion: health.version,
    controlUrl,
    gatewayUrl,
  };
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const baseUrl = option(argumentsList, "--base-url");
  const expectedBuild = option(argumentsList, "--expected-build");
  if (!baseUrl) {
    throw new Error(
      "Usage: runtime-smoke.mjs --base-url <functions-v1-url> [--expected-build <id>]",
    );
  }
  const result = await runRuntimeSmoke({ baseUrl, expectedBuild });
  console.log(
    `Supabase runtime smoke passed for ${result.instanceId} (${result.buildVersion})`,
  );
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entrypoint === import.meta.url) {
  await main();
}
