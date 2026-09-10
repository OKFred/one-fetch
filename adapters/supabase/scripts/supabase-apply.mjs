import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertFunctionTransition,
  deploymentFunctionSlugs,
  recoverySteps,
  serializableFunctionList,
} from "./deploy-support.mjs";

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

async function hashTree(root) {
  const hash = createHash("sha256");
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Recovery source cannot contain symbolic links");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        hash.update(path.slice(root.length).replaceAll("\\", "/"));
        hash.update(await readFile(path));
      } else throw new Error("Recovery source contains an unsupported entry");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function capturePriorFunctions(runPnpm, projectRef, statePath, runId) {
  const root = join(dirname(statePath), `recovery-${runId}`);
  await mkdir(join(root, "supabase"), { recursive: true });
  await writeFile(
    join(root, "supabase", "config.toml"),
    `project_id = "one-fetch-recovery"\n\n[functions.one-fetch-control]\nverify_jwt = false\n\n[functions.one-fetch-gateway]\nverify_jwt = false\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  for (const slug of deploymentFunctionSlugs) {
    runPnpm(
      [
        "exec",
        "supabase",
        "functions",
        "download",
        slug,
        "--project-ref",
        projectRef,
        "--use-api",
        "--workdir",
        root,
      ],
      { label: `download prior ${slug}` },
    );
  }
  return { root, sha256: await hashTree(root) };
}

async function restorePriorFunctions(runPnpm, projectRef, recovery) {
  for (const slug of deploymentFunctionSlugs) {
    runPnpm(
      [
        "exec",
        "supabase",
        "functions",
        "deploy",
        slug,
        "--project-ref",
        projectRef,
        "--no-verify-jwt",
        "--use-api",
        "--workdir",
        recovery.root,
      ],
      { label: `restore prior ${slug}` },
    );
  }
}

export function assertFirstInstallBackupIsEmpty(source) {
  if (
    /create\s+schema\s+(?:if\s+not\s+exists\s+)?"?one_fetch"?|one_fetch\./iu.test(
      source,
    )
  ) {
    throw new Error(
      "First install requires an empty one-fetch database schema",
    );
  }
}

async function createLogicalBackup(
  runPnpm,
  databaseLink,
  recorder,
  databasePassword,
) {
  const path = join(
    dirname(recorder.path),
    `database-before-${recorder.state.runId}.sql`,
  );
  await runPnpm(
    [
      "exec",
      "supabase",
      "db",
      "dump",
      "--workdir",
      databaseLink.workdir,
      "--linked",
      "--file",
      path,
      "--yes",
    ],
    {
      label: "Supabase logical backup",
      environment: { SUPABASE_DB_PASSWORD: databasePassword },
    },
  );
  const bytes = await readFile(path);
  if (bytes.length === 0) throw new Error("Supabase logical backup is empty");
  return {
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source: bytes.toString("utf8"),
  };
}

function deployFunction(runPnpm, projectRef, slug) {
  runPnpm(
    [
      "exec",
      "supabase",
      "functions",
      "deploy",
      slug,
      "--project-ref",
      projectRef,
      "--no-verify-jwt",
      "--use-api",
    ],
    { label: `deploy ${slug}` },
  );
}

async function tryRecovery(context, deployed, recovery, completed) {
  const result = {
    functionRollbackAttempted: false,
    functionRollbackSucceeded: false,
  };
  if (completed || deployed.length === 0) return result;
  result.functionRollbackAttempted = true;
  try {
    if (context.options.expectedCurrentBuild === "none") {
      for (const slug of [...deployed].reverse()) {
        context.runPnpm(
          [
            "exec",
            "supabase",
            "functions",
            "delete",
            slug,
            "--project-ref",
            context.options.projectRef,
            "--yes",
          ],
          { label: `remove partial ${slug}` },
        );
      }
    } else {
      await restorePriorFunctions(
        context.runPnpm,
        context.options.projectRef,
        recovery,
      );
    }
    result.functionRollbackSucceeded = true;
  } catch (error) {
    result.functionRollbackError =
      error instanceof Error ? error.message : "unknown";
  }
  return result;
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
    const backup = await createLogicalBackup(
      context.runPnpm,
      databaseLink,
      recorder,
      databasePassword,
    );
    if (options.expectedCurrentBuild === "none")
      assertFirstInstallBackupIsEmpty(backup.source);
    await recorder.update({
      status: "applying",
      phase,
      gatewayPaused: options.expectedCurrentBuild !== "none",
      backup: {
        path: backup.path,
        bytes: backup.bytes,
        sha256: backup.sha256,
        restoreVerified: false,
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
        "--env-file",
        resolve(options.envFile),
      ],
      { label: "set one-fetch Function secrets" },
    );
    let inventory = context.beforeFunctions;
    for (const slug of deploymentFunctionSlugs) {
      phase = slug === "one-fetch-control" ? "control" : "gateway";
      await rpc("of_renew_deployment_lease", {
        p_lease_id: leaseId,
        p_desired_build: desiredBuildId,
        p_ttl_seconds: 900,
      });
      deployFunction(context.runPnpm, options.projectRef, slug);
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
    if (leaseAcquired && !completed) {
      await rpc("of_fail_deployment", {
        p_lease_id: recorder.state.runId,
        p_reason_code: `${phase}-failed`,
      }).catch(() => undefined);
    }
    const rollback = await tryRecovery(context, deployed, recovery, completed);
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
