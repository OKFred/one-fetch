import { join } from "node:path";
import {
  createCloudflareCoordinator,
  coordinationIdentity,
  withCloudflareCoordination,
} from "./cloudflare-coordination.mjs";
import { createCloudflareD1Query } from "./cloudflare-d1-query.mjs";
import {
  runWrangler,
  currentVersionId,
  workerExists,
  repositoryRoot,
  setPaused,
} from "./cloudflare-runtime.mjs";
import { stateDirectory, writePrivateJson } from "./cloudflare-support.mjs";

export async function cloudflareAccount(values, state, run = runWrangler) {
  const identity = await run(["whoami", "--json"], { json: true });
  const accounts = identity?.accounts;
  const requested = values.get("--account-id") ?? state?.accountId;
  const accountId =
    requested ?? (accounts?.length === 1 ? accounts[0].id : undefined);
  if (
    identity?.loggedIn !== true ||
    !Array.isArray(accounts) ||
    !/^[a-f0-9]{32}$/u.test(accountId ?? "") ||
    !accounts.some((item) => item.id === accountId) ||
    (state?.accountId !== undefined && state.accountId !== accountId)
  )
    throw new Error(
      "Select an accessible --account-id matching the deployment record",
    );
  const pinned = (args, options = {}) => run(args, { ...options, accountId });
  return {
    accountId,
    values: new Map([...values, ["--account-id", accountId]]),
    run: pinned,
    current: (name) => currentVersionId(name, pinned),
    exists: (name) => workerExists(name, pinned),
  };
}

export function recoveryOptions(values, state) {
  const names = ["--recover-owner", "--recover-revision", "--confirm-stopped"];
  if (!names.some((name) => values.has(name))) return undefined;
  const owner = values.get(names[0]);
  const rawRevision = values.get(names[1]);
  const confirmStopped = values.get(names[2]);
  if (
    typeof rawRevision !== "string" ||
    !/^\d+$/u.test(rawRevision) ||
    confirmStopped !== state.deploymentId
  )
    throw new Error(
      "Recovery requires --recover-owner, --recover-revision and exact --confirm-stopped",
    );
  return { owner, revision: Number(rawRevision), confirmStopped };
}

export async function deploymentCoordinator(state, context, dependencies = {}) {
  coordinationIdentity(state);
  const databases = await context.run(["d1", "list", "--json"], { json: true });
  if (
    !Array.isArray(databases) ||
    !databases.some(
      (item) =>
        item.uuid === state.resources.databaseId &&
        item.name === state.resources.database,
    )
  )
    throw new Error(
      "Cloudflare D1 identity does not match the deployment record",
    );
  const query = await (dependencies.createQuery ?? createCloudflareD1Query)(
    state,
    { runWrangler: context.run },
  );
  return createCloudflareCoordinator(state, query);
}

export async function guardedCloudflareOperation(
  state,
  values,
  context,
  operation,
  work,
  dependencies = {},
) {
  const coordinator = await (dependencies.coordinator ?? deploymentCoordinator)(
    state,
    context,
  );
  const recovery = recoveryOptions(values, state);
  // A copied local checkpoint never selects an arbitrary remote build. Recovery
  // is tied to the exact retained owner + revision and explicitly stopped helpers.
  const remote = await coordinator.read();
  const expectedBuild = recovery
    ? remote.build_id
    : operation === "install"
      ? "none"
      : state.buildId;
  const record = dependencies.writePrivateJson ?? writePrivateJson;
  const root = dependencies.repositoryRoot ?? repositoryRoot;
  return withCloudflareCoordination(
    coordinator,
    {
      operation,
      expectedBuild,
      recovery,
      deletesDatabase: operation === "cleanup",
      recordLock: async (lock) => {
        const value = {
          schemaVersion: 1,
          owner: lock.owner,
          revision: lock.revision,
          expectedBuild,
          operation,
          acquiredAt: new Date().toISOString(),
        };
        await record(
          join(
            stateDirectory(root, state.deploymentId),
            "operations",
            `${lock.owner}.json`,
          ),
          value,
        );
      },
    },
    async (lock) => {
      const run = async (args, options) => {
        await lock.assertOwned();
        return context.run(args, options);
      };
      const guard = {
        ...context,
        lock,
        run,
        current: (name) => currentVersionId(name, run),
        exists: (name) => workerExists(name, run),
        pause: async (...args) => {
          await lock.assertOwned();
          return setPaused(...args);
        },
        write: async (...args) => {
          await lock.assertOwned();
          return record(...args);
        },
      };
      return work(guard);
    },
  );
}
