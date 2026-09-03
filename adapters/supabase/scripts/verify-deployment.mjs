import console from "node:console";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { URL } from "node:url";

import {
  assertHostedDeployment,
  readDeploymentEnvironment,
} from "./deploy-support.mjs";

function option(name, argumentsList = process.argv.slice(2)) {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
}

async function readJson(response, label) {
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}`);
  return response.json();
}

export async function verifyDeployment({
  buildId,
  environment,
  projectRef,
  fetch: request = globalThis.fetch,
}) {
  const { instanceId, controlUrl, gatewayUrl } = assertHostedDeployment(
    environment,
    projectRef,
  );
  const health = await readJson(
    await request(new URL("api/v1/health", `${controlUrl}/`)),
    "Control health",
  );
  if (
    health.instanceId !== instanceId ||
    health.service !== "one-fetch-control" ||
    health.version !== buildId
  ) {
    throw new Error("Control health does not match the deployed pair/build");
  }

  const capabilities = await readJson(
    await request(new URL("api/v1/capabilities", `${controlUrl}/`)),
    "Control capabilities",
  );
  if (
    capabilities.instanceId !== instanceId ||
    capabilities.controlGatewayPairId !== instanceId ||
    capabilities.buildVersion !== buildId
  ) {
    throw new Error(
      "Control capabilities do not match the deployed pair/build",
    );
  }

  const openApi = await readJson(
    await request(new URL("api/v1/openapi.json", `${controlUrl}/`)),
    "Control OpenAPI",
  );
  const prepareResponses =
    openApi.paths?.["/api/v1/auth/totp/prepare"]?.post?.responses;
  const enableResponses =
    openApi.paths?.["/api/v1/auth/totp/enable"]?.post?.responses;
  if (
    openApi.servers?.[0]?.url !== controlUrl.href ||
    !prepareResponses?.["501"] ||
    prepareResponses["200"] ||
    !enableResponses?.["501"] ||
    enableResponses["200"]
  ) {
    throw new Error("Control OpenAPI runtime overlay is not current");
  }

  const probe = await request(
    new URL(
      `__one_fetch_deploy_probe__?nonce=${randomUUID()}`,
      `${gatewayUrl}/`,
    ),
  );
  const probeBody = await probe.json().catch(() => undefined);
  if (probe.status !== 400 || probeBody?.error !== "invalid_metadata") {
    throw new Error(
      "Gateway did not return the expected safe protocol rejection",
    );
  }
}

async function main() {
  const projectRef = option("--project-ref");
  const envFile = option("--env-file");
  const expectedBuildId = option("--build-id");
  if (!projectRef || !envFile || !expectedBuildId) {
    throw new Error(
      "Usage: verify-deployment.mjs --project-ref <ref> --env-file <path> --build-id <id>",
    );
  }
  const environment = await readDeploymentEnvironment(envFile);
  let lastError;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await verifyDeployment({
        buildId: expectedBuildId,
        environment,
        projectRef,
      });
      console.log(`Verified Supabase pair/build ${expectedBuildId}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 10) await delay(2_000);
    }
  }
  throw lastError;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
