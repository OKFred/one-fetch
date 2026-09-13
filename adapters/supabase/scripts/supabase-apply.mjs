import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { capturePriorFunctions, tryRecovery } from "./supabase-recovery.mjs";
import {
  assertFunctionTransition,
  assertSecretRefreshTransition,
  deploymentFunctionSlugs,
  recoverySteps,
  serializableFunctionList,
} from "./deploy-support.mjs";
import {
  assertFirstInstallBackupIsEmpty,
  createLogicalBackup,
} from "./supabase-backup.mjs";
import { assertResumeMigrationIntegrity } from "./supabase-resume.mjs";

export { assertFirstInstallBackupIsEmpty } from "./supabase-backup.mjs";

async function readRestrictedValue(path, label) {
  if (!path) throw new Error(`${label} file is required for --apply`);
  const resolved = resolve(path);
  const details = await stat(resolved);
  if (!details.isFile()) throw new Error(`${label} path is not a file`);
  const value = (await readFile(resolved, "utf8")).trim();
  if (value.length < 16) throw new Error(`${label} file is empty or invalid`);
  return value;
}

export async function deploymentRpc(
  { fetch, projectRef, serviceRoleKey },
  name,
  body,
) {
  const response = await fetch(
    `https://${projectRef}.supabase.co/rest/v1/rpc/${name}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: globalThis.AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(`Deployment RPC ${name} failed with ${response.status}`);
  return response.json();
}

async function setPaused(fetch, environment, token, paused) {
  const controlBase = `${environment.get("ONE_FETCH_CONTROL_BASE_URL")}/`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const currentResponse = await fetch(
    new globalThis.URL("api/v1/config", controlBase),
    {
      headers,
      signal: globalThis.AbortSignal.timeout(15_000),
    },
  );
  if (!currentResponse.ok)
    throw new Error(`Configuration read failed with ${currentResponse.status}`);
  const current = await currentResponse.json();
  if (current.gatewayPaused === paused) return current;
  if (
    typeof current.version !== "string" ||
    current.version.length === 0 ||
    /["\r\n]/u.test(current.version)
  ) {
    throw new Error("Control returned an invalid configuration version");
  }
  const response = await fetch(
    new globalThis.URL("api/v1/config/gateway-paused", controlBase),
    {
      method: "PUT",
      headers: {
        ...headers,
        "If-Match": `"${current.version}"`,
      },
      body: JSON.stringify({ schemaVersion: 1, paused }),
      signal: globalThis.AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(`Gateway pause failed with ${response.status}`);
  const value = await response.json();
  if (value.gatewayPaused !== paused)
    throw new Error("Control did not confirm Gateway pause state");
  return value;
}

function deployFunction(runPnpm, projectRef, workdir, slug) {
  runPnpm(
    [
      "exec",
      "supabase",
      "functions",
      "deploy",
      slug,
      "--project-ref",
      projectRef,
      "--workdir",
      workdir,
      "--no-verify-jwt",
      "--use-api",
    ],
    { label: `deploy ${slug}` },
  );
}

export async function applyHostedDeployment(context) {
  const { options, recorder, desiredBuildId } = context;
  const serviceRoleKey = await readRestrictedValue(
    options.serviceRoleKeyFile,
    "service-role key",
  );
  const { databaseLink, databasePassword } = context;
  if (!databaseLink?.workdir || !databasePassword)
    throw new Error("Verified transient database link is required for --apply");
  const rpc = (name, body) =>
    deploymentRpc(
      { fetch: context.fetch, projectRef: options.projectRef, serviceRoleKey },
      name,
      body,
    );
  let adminToken;
  let recovery;
  let leaseAcquired = false;
  let completed = false;
  const deployed = [];
  const attempted = [];
  const renewLease = async () => {
    const result = await rpc("of_renew_deployment_lease", {
      p_lease_id: recorder.state.runId,
      p_desired_build: desiredBuildId,
      p_ttl_seconds: 900,
    });
    if (result.renewed !== true)
      throw new Error("Deployment lease renewal was not confirmed");
  };
  let phase = "backup";
  try {
    if (options.expectedCurrentBuild !== "none") {
      adminToken = await readRestrictedValue(
        options.adminTokenFile,
        "admin token",
      );
      await setPaused(context.fetch, context.environment, adminToken, true);
      recovery = await capturePriorFunctions(
        context.runPnpm,
        options.projectRef,
        recorder.path,
        recorder.state.runId,
      );
    }
    const backup = await createLogicalBackup({
      runPnpm: context.runPnpm,
      databaseLink,
      recorder,
      databasePassword,
      allowEmptyBaseline:
        options.expectedCurrentBuild === "none" && options.resume !== true,
      projectRef: options.projectRef,
      expectedCurrentBuild: options.expectedCurrentBuild,
    });
    if (options.expectedCurrentBuild === "none") {
      if (options.resume === true) {
        await assertResumeMigrationIntegrity({
          adapterRoot: context.adapterRoot,
          rpc,
        });
      } else {
        assertFirstInstallBackupIsEmpty(
          `${backup.schema.source}\n${backup.rpc.source}\n${backup.data.source}`,
        );
      }
    }
    await recorder.update({
      status: "applying",
      phase,
      gatewayPaused: options.expectedCurrentBuild !== "none",
      backup: {
        format: backup.format,
        schemas: backup.schemas,
        schema: {
          path: backup.schema.path,
          bytes: backup.schema.bytes,
          sha256: backup.schema.sha256,
        },
        data: {
          path: backup.data.path,
          bytes: backup.data.bytes,
          sha256: backup.data.sha256,
        },
        rpc: {
          path: backup.rpc.path,
          bytes: backup.rpc.bytes,
          sha256: backup.rpc.sha256,
          count: backup.rpc.count,
        },
        sha256: backup.sha256,
        restoreVerified: false,
        ...(backup.emptyBaseline
          ? { emptyBaseline: backup.emptyBaseline }
          : {}),
      },
      recovery,
    });

    const leaseId = recorder.state.runId;
    if (options.expectedCurrentBuild !== "none") {
      phase = "lease";
      const acquired = await rpc("of_acquire_deployment_lease", {
        p_expected_build: options.expectedCurrentBuild,
        p_desired_build: desiredBuildId,
        p_lease_id: leaseId,
        p_ttl_seconds: 900,
      });
      if (acquired.acquired !== true)
        throw new Error(
          `Deployment lease rejected: ${acquired.reason ?? "unknown"}`,
        );
      leaseAcquired = true;
    }

    phase = "database";
    context.runPnpm(
      [
        "exec",
        "supabase",
        "db",
        "push",
        "--workdir",
        databaseLink.workdir,
        "--linked",
        "--include-all",
        "--skip-vault",
        "--yes",
      ],
      {
        label: "apply forward migrations",
        environment: { SUPABASE_DB_PASSWORD: databasePassword },
      },
    );
    if (!leaseAcquired) {
      const acquired = await rpc("of_acquire_deployment_lease", {
        p_expected_build: "none",
        p_desired_build: desiredBuildId,
        p_lease_id: leaseId,
        p_ttl_seconds: 900,
      });
      if (acquired.acquired !== true)
        throw new Error(
          `Deployment lease rejected: ${acquired.reason ?? "unknown"}`,
        );
      leaseAcquired = true;
    }

    phase = "secrets";
    context.runPnpm(
      [
        "exec",
        "supabase",
        "secrets",
        "set",
        "--project-ref",
        options.projectRef,
        "--workdir",
        databaseLink.workdir,
        "--env-file",
        resolve(options.envFile),
      ],
      { label: "set one-fetch Function secrets" },
    );
    let inventory = context.beforeFunctions;
    if (options.expectedCurrentBuild !== "none") {
      const afterSecretRefresh = context.functionList();
      assertSecretRefreshTransition(inventory, afterSecretRefresh);
      inventory = afterSecretRefresh;
    }
    for (const slug of deploymentFunctionSlugs) {
      phase = slug === "one-fetch-control" ? "control" : "gateway";
      await renewLease();
      // A CLI failure can follow a successful remote write.
      attempted.push(slug);
      await recorder.update({ phase, attemptedFunctions: [...attempted] });
      deployFunction(
        context.runPnpm,
        options.projectRef,
        databaseLink.workdir,
        slug,
      );
      deployed.push(slug);
      const next = context.functionList();
      assertFunctionTransition(inventory, next, slug);
      inventory = next;
      await recorder.update({ phase, deployedFunctions: [...deployed] });
    }

    phase = "verify";
    const runtime = await context.inspectCurrent();
    if (runtime.buildId !== desiredBuildId)
      throw new Error(
        "Deployed Supabase runtime build does not match staged bundles",
      );
    await rpc("of_complete_deployment", {
      p_lease_id: leaseId,
      p_desired_build: desiredBuildId,
    });
    completed = true;
    if (options.resume === true && adminToken)
      await setPaused(context.fetch, context.environment, adminToken, false);
    return recorder.update({
      status: "verified",
      phase: "complete",
      gatewayPaused:
        options.expectedCurrentBuild !== "none" &&
        !(options.resume === true && adminToken),
      completedAt: new Date().toISOString(),
      remoteAfter: { functions: serializableFunctionList(inventory), runtime },
    });
  } catch (error) {
    // Keep our CAS lease until code recovery and runtime checks have settled.
    const rollback = await tryRecovery(
      {
        ...context,
        renewRecoveryLease: renewLease,
        confirmPaused: () =>
          setPaused(context.fetch, context.environment, adminToken, true),
      },
      attempted,
      recovery,
      completed,
    );
    if (leaseAcquired && !completed) {
      try {
        const released = await rpc("of_fail_deployment", {
          p_lease_id: recorder.state.runId,
          p_reason_code: `${phase}-failed`,
        });
        if (released.failed !== true)
          throw new Error("Deployment failure lease release was not confirmed");
        rollback.failureLeaseReleased = true;
      } catch {
        rollback.failureLeaseReleased = false;
      }
    }
    await recorder.update({
      status: "failed",
      phase,
      gatewayPaused: options.expectedCurrentBuild !== "none",
      failure:
        error instanceof Error ? error.message : "Unknown deployment failure",
      rollback,
      recoverySteps: recoverySteps(
        phase,
        desiredBuildId,
        options.expectedCurrentBuild,
      ),
    });
    throw error;
  }
}
