#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  assertHttpPreviewCapabilities,
  assertExpectedBuild,
  deploymentNames,
  failedDeploymentState,
  parseD1CreateOutput,
  parseWorkersUrl,
  readDeploymentState,
  resetDeploymentLifecycle,
  sha256File,
  stateDirectory,
  validateBuildId,
  validateSecretsFile,
  writePrivateJson,
} from "./cloudflare-support.mjs";
import {
  currentVersionId,
  readToken,
  repositoryRoot,
  runWrangler,
  setPaused,
  workerExists,
  writeConfigs,
} from "./cloudflare-runtime.mjs";

function parseArguments(values) {
  const result = new Map();
  const flags = new Set(["--resume"]);
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error(`Invalid argument ${key}`);
    if (flags.has(key)) {
      result.set(key, true);
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${key}`);
    result.set(key, value);
    index += 1;
  }
  return result;
}

function required(values, name) {
  const value = values.get(name);
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Missing required ${name}`);
  return value;
}

async function optionalState(deploymentId) {
  return readDeploymentState(repositoryRoot, deploymentId).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
}

export async function createCloudflareDeploymentPlan(values) {
  const deploymentId = required(values, "--deployment-id");
  const buildId = validateBuildId(required(values, "--build-id"));
  const expectedBuild = required(values, "--expected-build");
  const names = deploymentNames(deploymentId);
  const state = await optionalState(deploymentId);
  assertExpectedBuild(state, expectedBuild);
  if (state === undefined) {
    const [control, gateway, databases] = await Promise.all([
      workerExists(names.control),
      workerExists(names.gateway),
      runWrangler(["d1", "list", "--json"], { json: true }),
    ]);
    const database = databases.some((item) => item.name === names.database);
    if (control || gateway || database)
      throw new Error("Fresh install resource names already exist");
  }
  return {
    schemaVersion: 1,
    action: state === undefined ? "install" : "update",
    deploymentId,
    buildId,
    expectedBuild,
    resources: names,
    gatewayPauseRequired: state !== undefined,
    databaseRestoreAutomatic: false,
  };
}

async function inventoryFresh(plan, values) {
  const secretsPath = resolve(required(values, "--secrets-file"));
  await validateSecretsFile(secretsPath);
  const directory = stateDirectory(repositoryRoot, plan.deploymentId);
  await mkdir(directory, { recursive: true });
  const databaseOutput = await runWrangler([
    "d1",
    "create",
    plan.resources.database,
    "--location",
    "apac",
  ]);
  const databaseId = parseD1CreateOutput(databaseOutput);
  const provisional = {
    schemaVersion: 1,
    deploymentId: plan.deploymentId,
    buildId: plan.buildId,
    status: "provisioning",
    gatewayPaused: true,
    resources: { ...plan.resources, databaseId },
    createdAt: new Date().toISOString(),
  };
  await writePrivateJson(join(directory, "state.json"), provisional);
  const configs = await writeConfigs(
    directory,
    values,
    plan.deploymentId,
    plan.buildId,
    databaseId,
  );
  await runWrangler([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--remote",
    "--config",
    configs.control,
  ]);
  const controlOutput = await runWrangler([
    "deploy",
    "--config",
    configs.control,
    "--secrets-file",
    secretsPath,
  ]);
  const gatewayOutput = await runWrangler([
    "deploy",
    "--config",
    configs.gateway,
  ]);
  return {
    ...provisional,
    status: "awaiting-verification",
    controlUrl: parseWorkersUrl(controlOutput),
    gatewayUrl: parseWorkersUrl(gatewayOutput),
    workerVersions: {
      control: await currentVersionId(plan.resources.control),
      gateway: await currentVersionId(plan.resources.gateway),
    },
    configs,
    updatedAt: new Date().toISOString(),
  };
}

async function inventoryUpdate(plan, values, state) {
  const token = await readToken(required(values, "--admin-token-file"));
  await setPaused(state, token, true);
  const directory = stateDirectory(repositoryRoot, plan.deploymentId);
  const currentState = resetDeploymentLifecycle(state);
  const pausedState = { ...currentState, gatewayPaused: true };
  await writePrivateJson(join(directory, "state.json"), pausedState);
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backup = join(directory, `d1-${stamp}.sql`);
  const bookmark = await runWrangler(
    ["d1", "time-travel", "info", state.resources.databaseId, "--json"],
    { json: true },
  );
  await runWrangler([
    "d1",
    "export",
    state.resources.databaseId,
    "--remote",
    "--output",
    backup,
    "-y",
  ]);
  const previous = {
    buildId: state.buildId,
    controlVersionId: await currentVersionId(state.resources.control),
    gatewayVersionId: await currentVersionId(state.resources.gateway),
    databaseBookmark: bookmark.bookmark ?? bookmark,
    databaseBackup: backup,
    databaseBackupSha256: await sha256File(backup),
  };
  const configs = await writeConfigs(
    directory,
    values,
    plan.deploymentId,
    plan.buildId,
    state.resources.databaseId,
  );
  await runWrangler([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--remote",
    "--config",
    configs.control,
  ]);
  await runWrangler(["deploy", "--config", configs.control]);
  await runWrangler(["deploy", "--config", configs.gateway]);
  return {
    ...currentState,
    buildId: plan.buildId,
    status: "awaiting-verification",
    gatewayPaused: true,
    previous,
    workerVersions: {
      control: await currentVersionId(state.resources.control),
      gateway: await currentVersionId(state.resources.gateway),
    },
    configs,
    updatedAt: new Date().toISOString(),
  };
}

export async function applyCloudflareDeployment(values) {
  const plan = await createCloudflareDeploymentPlan(values);
  const previous = await optionalState(plan.deploymentId);
  let state;
  try {
    state =
      previous === undefined
        ? await inventoryFresh(plan, values)
        : await inventoryUpdate(plan, values, previous);
    await writePrivateJson(
      join(stateDirectory(repositoryRoot, plan.deploymentId), "state.json"),
      state,
    );
    return state;
  } catch (error) {
    const partial = (await optionalState(plan.deploymentId)) ?? previous;
    if (partial !== undefined) {
      await writePrivateJson(
        join(stateDirectory(repositoryRoot, plan.deploymentId), "state.json"),
        {
          ...failedDeploymentState(partial),
        },
      );
    }
    throw error;
  }
}

export async function verifyCloudflareDeployment(values) {
  const deploymentId = required(values, "--deployment-id");
  const expectedBuild = validateBuildId(required(values, "--expected-build"));
  let state = await readDeploymentState(repositoryRoot, deploymentId);
  assertExpectedBuild(state, expectedBuild);
  const [healthResponse, capabilitiesResponse] = await Promise.all([
    globalThis.fetch(new globalThis.URL("/api/v1/health", state.controlUrl), {
      cache: "no-store",
    }),
    globalThis.fetch(
      new globalThis.URL("/api/v1/capabilities", state.controlUrl),
      { cache: "no-store" },
    ),
  ]);
  if (!healthResponse.ok || !capabilitiesResponse.ok)
    throw new Error("Cloudflare Control verification failed");
  const [health, capabilities] = await Promise.all([
    healthResponse.json(),
    capabilitiesResponse.json(),
  ]);
  assertHttpPreviewCapabilities(capabilities, expectedBuild);
  if (values.get("--resume") === true) {
    const token = await readToken(required(values, "--admin-token-file"));
    await setPaused(state, token, false);
    state.gatewayPaused = false;
  }
  state = resetDeploymentLifecycle(state);
  state.status = "verified";
  state.verifiedAt = new Date().toISOString();
  await writePrivateJson(
    join(stateDirectory(repositoryRoot, deploymentId), "state.json"),
    state,
  );
  return {
    schemaVersion: 1,
    deploymentId,
    buildId: expectedBuild,
    health: health.status,
    gatewayResumed: !state.gatewayPaused,
  };
}

export async function rollbackCloudflareDeployment(values) {
  const deploymentId = required(values, "--deployment-id");
  const state = await readDeploymentState(repositoryRoot, deploymentId);
  assertExpectedBuild(state, required(values, "--expected-build"));
  if (!state.previous)
    throw new Error("No previous Cloudflare Worker versions are recorded");
  const token = await readToken(required(values, "--admin-token-file"));
  await setPaused(state, token, true);
  await runWrangler([
    "rollback",
    state.previous.gatewayVersionId,
    "--name",
    state.resources.gateway,
    "--yes",
  ]);
  await runWrangler([
    "rollback",
    state.previous.controlVersionId,
    "--name",
    state.resources.control,
    "--yes",
  ]);
  state.buildId = state.previous.buildId;
  state.status = "rolled-back";
  state.gatewayPaused = true;
  state.rolledBackAt = new Date().toISOString();
  await writePrivateJson(
    join(stateDirectory(repositoryRoot, deploymentId), "state.json"),
    state,
  );
  return {
    schemaVersion: 1,
    deploymentId,
    buildId: state.buildId,
    gatewayPaused: true,
    databaseRestored: false,
  };
}

export async function cleanupCloudflareDeployment(values) {
  const deploymentId = required(values, "--deployment-id");
  if (required(values, "--confirm-id") !== deploymentId)
    throw new Error("Cleanup confirmation must exactly match deployment ID");
  const state = await readDeploymentState(repositoryRoot, deploymentId);
  const failures = [];
  for (const name of [state.resources.gateway, state.resources.control]) {
    try {
      await runWrangler(["delete", name, "--force"]);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  try {
    await runWrangler(["d1", "delete", state.resources.databaseId, "-y"]);
  } catch (error) {
    failures.push(`${state.resources.database}: ${error.message}`);
  }
  const [control, gateway, databases] = await Promise.all([
    workerExists(state.resources.control),
    workerExists(state.resources.gateway),
    runWrangler(["d1", "list", "--json"], { json: true }),
  ]);
  if (
    control ||
    gateway ||
    databases.some(
      (item) =>
        item.uuid === state.resources.databaseId ||
        item.name === state.resources.database,
    )
  )
    failures.push("Remote inventory still contains deployment resources");
  state.status = failures.length === 0 ? "cleanup-verified" : "cleanup-failed";
  state.cleanupFailures = failures;
  state.cleanedAt = new Date().toISOString();
  await writePrivateJson(
    join(stateDirectory(repositoryRoot, deploymentId), "state.json"),
    state,
  );
  if (failures.length > 0)
    throw new Error(`Cloudflare cleanup incomplete: ${failures.join("; ")}`);
  return { schemaVersion: 1, deploymentId, cleanupVerified: true };
}

async function main() {
  const [mode, ...arguments_] = process.argv.slice(2);
  const values = parseArguments(arguments_);
  const handlers = {
    plan: createCloudflareDeploymentPlan,
    apply: applyCloudflareDeployment,
    verify: verifyCloudflareDeployment,
    rollback: rollbackCloudflareDeployment,
    cleanup: cleanupCloudflareDeployment,
  };
  const handler = handlers[mode];
  if (!handler)
    throw new Error(`Unsupported Cloudflare deployment mode ${mode}`);
  process.stdout.write(`${JSON.stringify(await handler(values), null, 2)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : "Unknown failure", recovery: "Keep Gateway paused, inspect the exact deployment state, and never restore D1 in place automatically." })}\n`,
    );
    process.exitCode = 1;
  });
}
