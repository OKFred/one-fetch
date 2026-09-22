import { join } from "node:path";
import {
  currentVersionId,
  readToken,
  repositoryRoot,
  runWrangler,
  setPaused,
  writeConfigs,
} from "./cloudflare-runtime.mjs";
import {
  assertHttpPreviewCapabilities,
  resetDeploymentLifecycle,
  sha256File,
  stateDirectory,
  writePrivateJson,
} from "./cloudflare-support.mjs";

export async function assertActiveVersions(state, current = currentVersionId) {
  const [control, gateway] = await Promise.all([
    current(state.resources.control),
    current(state.resources.gateway),
  ]);
  if (
    control !== state.workerVersions?.control ||
    gateway !== state.workerVersions?.gateway
  ) {
    throw new Error(
      "Active Cloudflare Worker versions differ from recorded state",
    );
  }
  return { control, gateway };
}

export async function assertControlBuild(state, fetch = globalThis.fetch) {
  const response = await fetch(
    new globalThis.URL("/api/v1/capabilities", state.controlUrl),
    {
      cache: "no-store",
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error("Cloudflare build preflight failed");
  assertHttpPreviewCapabilities(await response.json(), state.buildId);
}

// The CLI holds the D1 coordinator while this routine records local recovery
// evidence. Unknown outcomes remain unknown until explicit verification/rollback.
export async function inventoryCloudflareUpdate(
  plan,
  values,
  state,
  dependencies = {},
) {
  const run = dependencies.runWrangler ?? runWrangler;
  const current = dependencies.currentVersionId ?? currentVersionId;
  const pause = dependencies.setPaused ?? setPaused;
  const write = dependencies.writePrivateJson ?? writePrivateJson;
  const configsFor = dependencies.writeConfigs ?? writeConfigs;
  const digest = dependencies.sha256File ?? sha256File;
  const root = dependencies.repositoryRoot ?? repositoryRoot;
  const tokenFrom = dependencies.readToken ?? readToken;
  const checkBuild = dependencies.assertControlBuild ?? assertControlBuild;
  if (!["verified", "rolled-back"].includes(state.status)) {
    throw new Error(
      "Verify or recover the existing Cloudflare deployment before updating",
    );
  }
  const tokenPath = values.get("--admin-token-file");
  if (typeof tokenPath !== "string" || tokenPath.length === 0)
    throw new Error("Missing required --admin-token-file");
  const versions = await assertActiveVersions(state, current);
  await checkBuild(state);
  const token = await tokenFrom(tokenPath);
  const directory = stateDirectory(root, plan.deploymentId);
  const path = join(directory, "state.json");
  const checkpoint = resetDeploymentLifecycle(state);
  delete checkpoint.previous;
  checkpoint.status = "updating";
  checkpoint.update = {
    targetBuildId: plan.buildId,
    startedAt: new Date().toISOString(),
  };
  const record = async (phase) => {
    checkpoint.update.phase = phase;
    checkpoint.updatedAt = new Date().toISOString();
    await write(path, checkpoint);
  };

  checkpoint.gatewayPaused = null;
  await record("pause-intent");
  await pause(state, token, true);
  checkpoint.gatewayPaused = true;
  await record("paused");
  const stamp = checkpoint.update.startedAt.replaceAll(":", "-");
  const backup = join(directory, `d1-${stamp}.sql`);
  await record("backup-intent");
  const bookmark = await run(
    ["d1", "time-travel", "info", state.resources.databaseId, "--json"],
    { json: true },
  );
  if (typeof bookmark?.bookmark !== "string" || bookmark.bookmark.length === 0)
    throw new Error("D1 did not return a Time Travel bookmark");
  await run([
    "d1",
    "export",
    state.resources.databaseId,
    "--remote",
    "--output",
    backup,
    "-y",
  ]);
  checkpoint.previous = {
    buildId: state.buildId,
    controlVersionId: versions.control,
    gatewayVersionId: versions.gateway,
    databaseBookmark: bookmark.bookmark,
    databaseBackup: backup,
    databaseBackupSha256: await digest(backup),
  };
  await record("backup-recorded");
  // Catch out-of-band deployment changes before the first schema/code mutation.
  await assertActiveVersions(state, current);
  const configs = await configsFor(
    directory,
    values,
    plan.deploymentId,
    plan.buildId,
    state.resources.databaseId,
  );
  checkpoint.configs = configs;
  await record("migrations-intent");
  await run([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--remote",
    "--config",
    configs.control,
  ]);
  await record("migrations-applied");
  await record("control-deploy-intent");
  await run(["deploy", "--config", configs.control]);
  await record("control-deployed");
  await record("gateway-deploy-intent");
  await run(["deploy", "--config", configs.gateway]);
  await record("gateway-deployed");
  checkpoint.workerVersions = {
    control: await current(state.resources.control),
    gateway: await current(state.resources.gateway),
  };
  checkpoint.buildId = plan.buildId;
  checkpoint.status = "awaiting-verification";
  await record("awaiting-verification");
  return checkpoint;
}
