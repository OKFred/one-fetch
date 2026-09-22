import { join } from "node:path";
import { createCloudflareD1Query } from "./cloudflare-d1-query.mjs";
import {
  COORDINATION_TABLE,
  coordinationIdentity,
  createCloudflareCoordinator,
} from "./cloudflare-coordination.mjs";
import {
  cloudflareAccount,
  deploymentCoordinator,
} from "./cloudflare-guard.mjs";
import { readToken, repositoryRoot, setPaused } from "./cloudflare-runtime.mjs";
import {
  assertActiveVersions,
  assertControlBuild,
} from "./cloudflare-update.mjs";
import {
  assertExpectedBuild,
  readDeploymentState,
  sha256File,
  stateDirectory,
  writePrivateJson,
} from "./cloudflare-support.mjs";

export async function inspectCloudflareCoordination(values) {
  const state = await readDeploymentState(
    repositoryRoot,
    values.get("--deployment-id"),
  );
  const context = await cloudflareAccount(values, state);
  // Read-only inspection can also recover an unacknowledged adoption checkpoint.
  const coordinator = await deploymentCoordinator(
    { ...state, accountId: context.accountId },
    context,
  );
  return { schemaVersion: 1, coordination: await coordinator.read() };
}

export async function adoptCloudflareCoordination(values, dependencies = {}) {
  const root = dependencies.repositoryRoot ?? repositoryRoot;
  const state = await (dependencies.readState ?? readDeploymentState)(
    root,
    values.get("--deployment-id"),
  );
  assertExpectedBuild(state, values.get("--expected-build"));
  if (
    values.get("--confirm-stopped") !== state.deploymentId ||
    !values.has("--account-id")
  )
    throw new Error(
      "Adoption requires an explicit --account-id and exact --confirm-stopped after stopping all deployment helpers",
    );
  if (!["verified", "rolled-back"].includes(state.status))
    throw new Error(
      "Only a verified deployment can adopt coordination; recover incomplete legacy deployments manually",
    );
  const context = await (dependencies.account ?? cloudflareAccount)(
    values,
    state,
  );
  const bound = { ...state, accountId: context.accountId };
  coordinationIdentity(bound);
  const databases = await context.run(["d1", "list", "--json"], { json: true });
  if (
    !Array.isArray(databases) ||
    !databases.some(
      (item) =>
        item.uuid === state.resources.databaseId &&
        item.name === state.resources.database,
    )
  )
    throw new Error("Adoption database identity mismatch");
  const query = await (dependencies.createQuery ?? createCloudflareD1Query)(
    bound,
    { runWrangler: context.run },
  );
  const tables = await query("SELECT name FROM sqlite_master WHERE name = ?", [
    COORDINATION_TABLE,
  ]);
  if (tables.length !== 0)
    throw new Error(
      "Coordination already exists; inspect it instead of adopting or overwriting",
    );
  await assertActiveVersions(state, context.current);
  await (dependencies.checkBuild ?? assertControlBuild)(state);
  const token = await (dependencies.readToken ?? readToken)(
    values.get("--admin-token-file"),
  );
  const write = dependencies.write ?? writePrivateJson;
  const directory = stateDirectory(root, state.deploymentId);
  const checkpoint = {
    ...bound,
    gatewayPaused: null,
    adoption: { phase: "pause-intent", startedAt: new Date().toISOString() },
  };
  await write(join(directory, "state.json"), checkpoint);
  await (dependencies.pause ?? setPaused)(state, token, true);
  checkpoint.gatewayPaused = true;
  checkpoint.adoption.phase = "paused";
  await write(join(directory, "state.json"), checkpoint);
  const backup = join(
    directory,
    `pre-coordination-${globalThis.crypto.randomUUID()}.sql`,
  );
  await context.run([
    "d1",
    "export",
    state.resources.databaseId,
    "--remote",
    "--output",
    backup,
    "-y",
  ]);
  checkpoint.adoption.backup = backup;
  checkpoint.adoption.sha256 = await (dependencies.digest ?? sha256File)(
    backup,
  );
  checkpoint.adoption.phase = "initialize-intent";
  await write(join(directory, "state.json"), checkpoint);
  await assertActiveVersions(state, context.current);
  // No IF NOT EXISTS: racing adoption or any existing coordination must fail closed.
  const coordinator = createCloudflareCoordinator(bound, query);
  await coordinator.initialize(state.buildId);
  const lock = await coordinator.acquire("verify", state.buildId);
  checkpoint.adoption.phase = "complete";
  await lock.assertOwned();
  await write(join(directory, "state.json"), checkpoint);
  await lock.complete(state.buildId);
  return {
    schemaVersion: 1,
    deploymentId: state.deploymentId,
    accountId: context.accountId,
    buildId: state.buildId,
    gatewayPaused: true,
    coordination: await coordinator.read(),
  };
}
