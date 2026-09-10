import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { URL } from "node:url";

import {
  assertExpectedCurrentBuild,
  assertFunctionBaseline,
  assertHostedDeployment,
  parseFunctionList,
  readDeploymentEnvironment,
  serializableFunctionList,
} from "./deploy-support.mjs";
import { applyHostedDeployment } from "./supabase-apply.mjs";
import {
  createTransientDatabaseLink,
  readDatabasePassword,
} from "./transient-database-link.mjs";

const adapterRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(adapterRoot, "../..");
const require = createRequire(import.meta.url);
const pnpmCli = join(dirname(require.resolve("pnpm")), "bin", "pnpm.cjs");
export function pnpmInvocation(args) {
  return { file: process.execPath, args: [pnpmCli, ...args] };
}

export function parseOptions(argumentsList) {
  const options = { apply: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--apply" || argument === "--resume") {
      options[argument === "--apply" ? "apply" : "resume"] = true;
      continue;
    }
    if (
      argument === "--project-ref" ||
      argument === "--env-file" ||
      argument === "--expected-current-build" ||
      argument === "--state-file" ||
      argument === "--service-role-key-file" ||
      argument === "--db-password-file" ||
      argument === "--admin-token-file"
    ) {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${argument}`);
      }
      options[
        {
          "--project-ref": "projectRef",
          "--env-file": "envFile",
          "--expected-current-build": "expectedCurrentBuild",
          "--state-file": "stateFile",
          "--service-role-key-file": "serviceRoleKeyFile",
          "--db-password-file": "dbPasswordFile",
          "--admin-token-file": "adminTokenFile",
        }[argument]
      ] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (
    !options.projectRef ||
    !options.envFile ||
    !options.expectedCurrentBuild
  ) {
    throw new Error(
      "Usage: deploy-release.mjs --project-ref <ref> --env-file <path> --expected-current-build <id|none> [--db-password-file <path>] [--state-file <path>] [--apply --service-role-key-file <path> [--admin-token-file <path>] [--resume]]",
    );
  }
  assertExpectedCurrentBuild(options.expectedCurrentBuild);
  if (options.resume && !options.apply) {
    throw new Error("--resume requires --apply");
  }
  if (
    options.apply &&
    (!options.serviceRoleKeyFile ||
      !options.dbPasswordFile ||
      (options.expectedCurrentBuild !== "none" && !options.adminTokenFile))
  ) {
    throw new Error(
      "--apply requires service-role and database-password files; updates also require an admin-token file",
    );
  }
  return options;
}

function commandText(file, args) {
  return [file, ...args].join(" ");
}

function runCommand(file, args, options = {}) {
  const { capture = false, label = commandText(file, args) } = options;
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? adapterRoot,
    encoding: "utf8",
    env: { ...process.env, ...(options.environment ?? {}) },
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail =
      capture && result.stderr?.trim() ? `: ${result.stderr.trim()}` : "";
    throw new Error(`${label} failed with exit code ${result.status}${detail}`);
  }
  return capture ? result.stdout : "";
}

function runPnpm(command, args, options) {
  const invocation = pnpmInvocation(args);
  return command(invocation.file, invocation.args, options);
}

async function readJsonResponse(response, label) {
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

async function requestWithTimeout(request, input, label, timeoutMs = 10_000) {
  try {
    return await request(input, {
      signal: globalThis.AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} failed within ${timeoutMs} ms: ${detail}`);
  }
}

export async function inspectCurrentDeployment({
  environment,
  projectRef,
  fetch: request,
}) {
  const { instanceId, controlUrl, gatewayUrl } = assertHostedDeployment(
    environment,
    projectRef,
  );
  const health = await readJsonResponse(
    await requestWithTimeout(
      request,
      new URL("api/v1/health", `${controlUrl}/`),
      "Current Control health",
    ),
    "Current Control health",
  );
  const capabilities = await readJsonResponse(
    await requestWithTimeout(
      request,
      new URL("api/v1/capabilities", `${controlUrl}/`),
      "Current Control capabilities",
    ),
    "Current Control capabilities",
  );
  if (
    health.instanceId !== instanceId ||
    health.service !== "one-fetch-control" ||
    health.status !== "ok" ||
    typeof health.version !== "string" ||
    capabilities.instanceId !== instanceId ||
    capabilities.controlGatewayPairId !== instanceId ||
    capabilities.buildVersion !== health.version
  ) {
    throw new Error(
      "Current Control pair/build is unhealthy or internally inconsistent",
    );
  }
  const probe = await requestWithTimeout(
    request,
    new URL(
      `__one_fetch_deploy_probe__?nonce=${randomUUID()}`,
      `${gatewayUrl}/`,
    ),
    "Current Gateway build probe",
  );
  const probeBody = await probe.json().catch(() => undefined);
  if (
    probe.status !== 400 ||
    probeBody?.error !== "invalid_metadata" ||
    probe.headers.get("one-fetch-build-version") !== health.version
  ) {
    throw new Error("Current Gateway did not pass the safe protocol probe");
  }
  return { buildId: health.version, instanceId };
}

class StateRecorder {
  constructor(path, state) {
    this.path = path;
    this.state = state;
  }

  static async create(path, state) {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    return new StateRecorder(path, state);
  }

  async update(patch) {
    this.state = {
      ...this.state,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, this.path);
    return this.state;
  }
}

function defaultStatePath(projectRef, buildId) {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return join(
    repositoryRoot,
    "artifacts",
    "supabase-deployments",
    `${timestamp}-${projectRef}-${buildId}.json`,
  );
}

function functionList(command = runCommand, projectRef, workdir) {
  return parseFunctionList(
    runPnpm(
      command,
      [
        "exec",
        "supabase",
        "functions",
        "list",
        "--project-ref",
        projectRef,
        "--workdir",
        workdir,
        "--output",
        "json",
      ],
      { capture: true, label: "Supabase Function inventory" },
    ),
  );
}

async function bundleEvidence(desiredBuildId) {
  const evidence = [];
  for (const functionName of ["one-fetch-control", "one-fetch-gateway"]) {
    const root = join(
      adapterRoot,
      "supabase",
      "functions",
      functionName,
      ".one-fetch-bundle",
    );
    const manifest = JSON.parse(
      await readFile(join(root, "manifest.json"), "utf8"),
    );
    const bytes = await readFile(join(root, "index.js"));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      manifest.schemaVersion !== 1 ||
      manifest.functionName !== functionName ||
      manifest.buildVersion !== desiredBuildId ||
      manifest.bytes !== bytes.length ||
      manifest.sha256 !== sha256
    ) {
      throw new Error(`Staged ${functionName} bundle evidence is inconsistent`);
    }
    evidence.push({ functionName, bytes: bytes.length, sha256 });
  }
  return evidence;
}

function backupSummary(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Supabase backup inventory did not return JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Supabase backup inventory has an invalid shape");
  }
  return {
    region: typeof parsed.region === "string" ? parsed.region : null,
    pitrEnabled: parsed.pitr_enabled === true,
    walgEnabled: parsed.walg_enabled === true,
    physicalBackupCount: Array.isArray(parsed.backups)
      ? parsed.backups.length
      : 0,
    immutableBackupVerified: false,
    restoreTestVerified: false,
  };
}

export async function runDeployment({
  options,
  command = runCommand,
  fetch: request = globalThis.fetch,
  readBundles = bundleEvidence,
  createDatabaseLink = createTransientDatabaseLink,
}) {
  const envFile = resolve(options.envFile);
  const environment = await readDeploymentEnvironment(envFile);
  assertHostedDeployment(environment, options.projectRef);
  const databasePassword = await readDatabasePassword(options);
  runPnpm(command, ["run", "predeploy"], {
    label: "local deployment preflight",
  });
  const desiredBuildId = command(
    process.execPath,
    [
      "scripts/build-id.mjs",
      "--project-ref",
      options.projectRef,
      "--env-file",
      envFile,
    ],
    { capture: true, label: "build identity preflight" },
  ).trim();
  if (desiredBuildId === "none") {
    throw new Error(
      "Build identity preflight returned the reserved value 'none'",
    );
  }
  assertExpectedCurrentBuild(desiredBuildId);
  if (desiredBuildId === options.expectedCurrentBuild) {
    throw new Error("Desired build already matches the declared current build");
  }
  command(
    process.execPath,
    ["scripts/check-bundles.mjs", "--stage", "--build-id", desiredBuildId],
    { label: "exact build bundle staging" },
  );
  const bundles = await readBundles(desiredBuildId);

  const databaseLink = await createDatabaseLink({
    adapterRoot,
    projectRef: options.projectRef,
    databasePassword,
    runPnpm: (arguments_, commandOptions) =>
      runPnpm(command, arguments_, commandOptions),
  });
  try {
    const beforeFunctions = functionList(
      command,
      options.projectRef,
      databaseLink.workdir,
    );
    assertFunctionBaseline(beforeFunctions, options.expectedCurrentBuild);
    let currentRuntime = null;
    if (options.expectedCurrentBuild !== "none") {
      currentRuntime = await inspectCurrentDeployment({
        environment,
        projectRef: options.projectRef,
        fetch: request,
      });
      if (currentRuntime.buildId !== options.expectedCurrentBuild) {
        throw new Error(
          `Current runtime build ${currentRuntime.buildId} does not match expected ${options.expectedCurrentBuild}`,
        );
      }
      const commitPrefix = options.expectedCurrentBuild.slice(
        options.expectedCurrentBuild.lastIndexOf(".g") + 2,
      );
      command("git", ["cat-file", "-e", `${commitPrefix}^{commit}`], {
        label: "prior immutable commit recovery check",
      });
    }
    runPnpm(
      command,
      [
        "exec",
        "supabase",
        "db",
        "push",
        "--workdir",
        databaseLink.workdir,
        "--linked",
        "--include-all",
        "--dry-run",
        "--skip-vault",
      ],
      {
        label: "remote migration dry-run",
        environment: { SUPABASE_DB_PASSWORD: databasePassword },
      },
    );
    const backups = backupSummary(
      runPnpm(
        command,
        [
          "exec",
          "supabase",
          "backups",
          "list",
          "--project-ref",
          options.projectRef,
          "--workdir",
          databaseLink.workdir,
          "--output",
          "json",
        ],
        { capture: true, label: "Supabase backup inventory" },
      ),
    );
    const envDigest = createHash("sha256")
      .update(await readFile(envFile))
      .digest("hex");
    const createdAt = new Date().toISOString();
    const statePath = resolve(
      options.stateFile ?? defaultStatePath(options.projectRef, desiredBuildId),
    );
    const recorder = await StateRecorder.create(statePath, {
      schemaVersion: 1,
      runId: randomUUID(),
      createdAt,
      updatedAt: createdAt,
      projectRef: options.projectRef,
      desiredBuildId,
      expectedCurrentBuild: options.expectedCurrentBuild,
      environmentSha256: envDigest,
      status: "ready",
      phase: "preflight",
      bundles,
      backups,
      remoteBefore: {
        functions: serializableFunctionList(beforeFunctions),
        runtime: currentRuntime,
      },
      apply: {
        available: true,
        databaseRestoreAutomatic: false,
        requiresServiceRoleKeyFile: true,
        requiresDatabasePasswordFile: true,
      },
    });
    if (options.apply) {
      return applyHostedDeployment({
        adapterRoot,
        options,
        environment,
        desiredBuildId,
        recorder,
        beforeFunctions,
        command,
        databaseLink,
        databasePassword,
        runPnpm: (arguments_, commandOptions) =>
          runPnpm(command, arguments_, commandOptions),
        functionList: () =>
          functionList(command, options.projectRef, databaseLink.workdir),
        inspectCurrent: () =>
          inspectCurrentDeployment({
            environment,
            projectRef: options.projectRef,
            fetch: request,
          }),
        fetch: request,
      });
    }
    process.stdout.write(`Read-only preflight passed. State: ${statePath}\n`);
    return recorder.state;
  } finally {
    await databaseLink.cleanup();
  }
}

async function main() {
  await runDeployment({ options: parseOptions(process.argv.slice(2)) });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
