#!/usr/bin/env node
import { join, resolve } from "node:path";
import process from "node:process";
import {
  assertHttpPreviewCapabilities,
  assertExpectedBuild,
  deploymentNames,
  failedDeploymentState,
  readDeploymentState,
  resetDeploymentLifecycle,
  stateDirectory,
  validateBuildId,
} from "./cloudflare-support.mjs";
import {
  readToken,
  repositoryRoot,
  writeConfigs,
} from "./cloudflare-runtime.mjs";
import {
  assertActiveVersions,
  inventoryCloudflareUpdate,
} from "./cloudflare-update.mjs";
import {
  cloudflareAccount,
  guardedCloudflareOperation,
} from "./cloudflare-guard.mjs";
import { installCloudflareDeployment } from "./cloudflare-install.mjs";
import { cleanupCloudflareDeployment } from "./cloudflare-cleanup.mjs";
import {
  adoptCloudflareCoordination,
  inspectCloudflareCoordination,
} from "./cloudflare-adopt.mjs";
export { cleanupCloudflareDeployment } from "./cloudflare-cleanup.mjs";

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
  if (state !== undefined && state.buildId === buildId)
    throw new Error(
      "An update requires a distinct build ID; never reuse deployed build identifiers",
    );
  const context = await cloudflareAccount(values, state);
  if (state === undefined) {
    const [control, gateway, databases] = await Promise.all([
      context.exists(names.control),
      context.exists(names.gateway),
      context.run(["d1", "list", "--json"], { json: true }),
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
    accountId: context.accountId,
    resources: names,
    gatewayPauseRequired: state !== undefined,
    databaseRestoreAutomatic: false,
  };
}

export async function applyCloudflareDeployment(values) {
  const plan = await createCloudflareDeploymentPlan(values);
  const previous = await optionalState(plan.deploymentId);
  const context = await cloudflareAccount(
    new Map([...values, ["--account-id", plan.accountId]]),
    previous,
  );
  if (previous === undefined)
    return installCloudflareDeployment(plan, values, context);
  // A lock loser must not mark the winning operation's state as failed.
  return guardedCloudflareOperation(
    previous,
    values,
    context,
    "apply",
    async (guard) => {
      try {
        return await inventoryCloudflareUpdate(plan, context.values, previous, {
          runWrangler: guard.run,
          currentVersionId: guard.current,
          setPaused: guard.pause,
          writePrivateJson: guard.write,
          writeConfigs: async (...args) => {
            await guard.lock.assertOwned();
            return writeConfigs(...args);
          },
        });
      } catch (error) {
        const partial = (await optionalState(plan.deploymentId)) ?? previous;
        await guard.write(
          join(stateDirectory(repositoryRoot, plan.deploymentId), "state.json"),
          failedDeploymentState(partial),
        );
        throw error;
      }
    },
  );
}

export async function verifyCloudflareDeployment(values) {
  const deploymentId = required(values, "--deployment-id");
  const expectedBuild = validateBuildId(required(values, "--expected-build"));
  let state = await readDeploymentState(repositoryRoot, deploymentId);
  assertExpectedBuild(state, expectedBuild);
  if (
    !["awaiting-verification", "verified", "rolled-back"].includes(state.status)
  )
    throw new Error(
      "Recover the incomplete Cloudflare deployment before verification or resume",
    );
  const context = await cloudflareAccount(values, state);
  return guardedCloudflareOperation(
    state,
    values,
    context,
    "verify",
    async (guard) => {
      await assertActiveVersions(state, guard.current);
      const [healthResponse, capabilitiesResponse] = await Promise.all([
        globalThis.fetch(
          new globalThis.URL("/api/v1/health", state.controlUrl),
          {
            cache: "no-store",
            redirect: "error",
            signal: globalThis.AbortSignal.timeout(15_000),
          },
        ),
        globalThis.fetch(
          new globalThis.URL("/api/v1/capabilities", state.controlUrl),
          {
            cache: "no-store",
            redirect: "error",
            signal: globalThis.AbortSignal.timeout(15_000),
          },
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
        await guard.pause(state, token, false);
        state.gatewayPaused = false;
      }
      state = resetDeploymentLifecycle(state);
      state.status = "verified";
      state.verifiedAt = new Date().toISOString();
      await guard.write(
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
    },
  );
}

export async function rollbackCloudflareDeployment(values) {
  const deploymentId = required(values, "--deployment-id");
  const state = await readDeploymentState(repositoryRoot, deploymentId);
  assertExpectedBuild(state, required(values, "--expected-build"));
  if (!state.previous)
    throw new Error("No previous Cloudflare Worker versions are recorded");
  const context = await cloudflareAccount(values, state);
  return guardedCloudflareOperation(
    state,
    values,
    context,
    "rollback",
    async (guard) => {
      const token = await readToken(required(values, "--admin-token-file"));
      await guard.pause(state, token, true);
      await guard.run([
        "rollback",
        state.previous.gatewayVersionId,
        "--name",
        state.resources.gateway,
        "--yes",
      ]);
      await guard.run([
        "rollback",
        state.previous.controlVersionId,
        "--name",
        state.resources.control,
        "--yes",
      ]);
      state.buildId = state.previous.buildId;
      state.workerVersions = {
        control: state.previous.controlVersionId,
        gateway: state.previous.gatewayVersionId,
      };
      await assertActiveVersions(state, guard.current);
      state.status = "rolled-back";
      state.gatewayPaused = true;
      state.rolledBackAt = new Date().toISOString();
      await guard.write(
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
    },
  );
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
    adopt: adoptCloudflareCoordination,
    coordination: inspectCloudflareCoordination,
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
