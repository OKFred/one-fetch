import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  deploymentCoordinator,
  guardedCloudflareOperation,
} from "./cloudflare-guard.mjs";
import { repositoryRoot, writeConfigs } from "./cloudflare-runtime.mjs";
import {
  parseD1CreateOutput,
  parseWorkersUrl,
  stateDirectory,
  validateSecretsFile,
  writePrivateJson,
} from "./cloudflare-support.mjs";

export async function installCloudflareDeployment(plan, values, context) {
  const input = values.get("--secrets-file");
  if (typeof input !== "string")
    throw new Error("Missing required --secrets-file");
  const secretsPath = resolve(input);
  await validateSecretsFile(secretsPath);
  const directory = stateDirectory(repositoryRoot, plan.deploymentId);
  await mkdir(directory, { recursive: true });
  const output = await context.run([
    "d1",
    "create",
    plan.resources.database,
    "--location",
    "apac",
  ]);
  const databaseId = parseD1CreateOutput(output);
  const state = {
    schemaVersion: 1,
    deploymentId: plan.deploymentId,
    accountId: context.accountId,
    buildId: plan.buildId,
    status: "provisioning",
    gatewayPaused: true,
    resources: { ...plan.resources, databaseId },
    createdAt: new Date().toISOString(),
  };
  // D1 creation is unique by name. Never adopt a name collision as a fresh install.
  await writePrivateJson(join(directory, "state.json"), state);
  const coordinator = await deploymentCoordinator(state, context);
  await coordinator.initialize("none");
  return guardedCloudflareOperation(
    state,
    values,
    context,
    "install",
    async (guard) => {
      await guard.lock.assertOwned();
      const configs = await writeConfigs(
        directory,
        context.values,
        plan.deploymentId,
        plan.buildId,
        databaseId,
      );
      state.configs = configs;
      await guard.write(join(directory, "state.json"), state);
      await guard.run([
        "d1",
        "migrations",
        "apply",
        "DB",
        "--remote",
        "--config",
        configs.control,
      ]);
      const controlOutput = await guard.run([
        "deploy",
        "--config",
        configs.control,
        "--secrets-file",
        secretsPath,
      ]);
      state.controlUrl = parseWorkersUrl(controlOutput);
      await guard.write(join(directory, "state.json"), state);
      const gatewayOutput = await guard.run([
        "deploy",
        "--config",
        configs.gateway,
      ]);
      state.gatewayUrl = parseWorkersUrl(gatewayOutput);
      state.workerVersions = {
        control: await guard.current(state.resources.control),
        gateway: await guard.current(state.resources.gateway),
      };
      state.status = "awaiting-verification";
      state.updatedAt = new Date().toISOString();
      await guard.write(join(directory, "state.json"), state);
      return state;
    },
    { coordinator: async () => coordinator },
  );
}
