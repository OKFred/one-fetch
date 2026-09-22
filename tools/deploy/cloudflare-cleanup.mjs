import { join } from "node:path";
import {
  cloudflareAccount,
  guardedCloudflareOperation,
} from "./cloudflare-guard.mjs";
import { repositoryRoot } from "./cloudflare-runtime.mjs";
import {
  readDeploymentState,
  stateDirectory,
  writePrivateJson,
} from "./cloudflare-support.mjs";

export async function cleanupCloudflareDeployment(values) {
  const deploymentId = values.get("--deployment-id");
  if (
    typeof deploymentId !== "string" ||
    values.get("--confirm-id") !== deploymentId
  )
    throw new Error("Cleanup confirmation must exactly match deployment ID");
  const state = await readDeploymentState(repositoryRoot, deploymentId);
  const context = await cloudflareAccount(values, state);
  return guardedCloudflareOperation(
    state,
    values,
    context,
    "cleanup",
    async (guard) => {
      // Retain D1 (and its lock) if any Worker deletion has an unknown outcome.
      for (const name of [state.resources.gateway, state.resources.control]) {
        if (await guard.exists(name))
          await guard.run(["delete", name, "--force"]);
        if (await guard.exists(name))
          throw new Error(
            "Worker deletion was not confirmed; retain D1 for recovery",
          );
      }
      state.status = "cleanup-database-intent";
      await guard.write(
        join(stateDirectory(repositoryRoot, deploymentId), "state.json"),
        state,
      );
      await guard.run(["d1", "delete", state.resources.databaseId, "-y"]);
      // The lock no longer exists. These final checks are read-only, still account-pinned.
      const [control, gateway, databases] = await Promise.all([
        context.exists(state.resources.control),
        context.exists(state.resources.gateway),
        context.run(["d1", "list", "--json"], { json: true }),
      ]);
      if (
        control ||
        gateway ||
        !Array.isArray(databases) ||
        databases.some(
          (item) =>
            item.uuid === state.resources.databaseId ||
            item.name === state.resources.database,
        )
      )
        throw new Error(
          "Cleanup inventory is not empty; inspect ownership before any retry",
        );
      state.status = "cleanup-verified";
      state.cleanedAt = new Date().toISOString();
      await writePrivateJson(
        join(stateDirectory(repositoryRoot, deploymentId), "state.json"),
        state,
      );
      return { schemaVersion: 1, deploymentId, cleanupVerified: true };
    },
  );
}
