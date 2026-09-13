import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";

const MINIMUM_NODE = [24, 20, 0];
const VERSION_PATTERN = /^0\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u;

export function assertDeploymentRuntime(version = process.versions.node) {
  const parts = version.split(".").map(Number);
  const belowMinimum = MINIMUM_NODE.some(
    (part, index) =>
      parts[index] < part &&
      MINIMUM_NODE.slice(0, index).every(
        (earlier, earlierIndex) => parts[earlierIndex] === earlier,
      ),
  );
  if (
    parts.some(Number.isNaN) ||
    parts[0] === undefined ||
    parts[0] >= 27 ||
    belowMinimum
  ) {
    throw new Error(`Node >=24.20.0 <27 is required; current ${version}`);
  }
}

function parseArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error(`Invalid argument ${key}`);
    if (key === "--resume") {
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

function required(argumentsMap, name) {
  const value = argumentsMap.get(name);
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Missing required ${name}`);
  return value;
}

export function safeDeploymentRoot(value) {
  const root = resolve(value);
  if (root === parse(root).root || root === resolve(homedir())) {
    throw new Error("Deployment root must be a dedicated subdirectory");
  }
  return root;
}

async function exists(path) {
  return Boolean(await stat(path).catch(() => undefined));
}

async function digestFile(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function tarOutput(archive, ...arguments_) {
  return execFileSync("tar", [arguments_[0], archive, ...arguments_.slice(1)], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

export function assertSafeArchiveEntries(names, verbose = "") {
  if (names.length === 0) throw new Error("Node archive is empty");
  for (const raw of names) {
    const name = raw.replaceAll("\\", "/").replace(/\/$/u, "");
    if (
      name !== "one-fetch" &&
      (!name.startsWith("one-fetch/") ||
        name.split("/").some((part) => part === ".." || part === ""))
    ) {
      throw new Error(`Unsafe Node archive entry: ${raw}`);
    }
  }
  if (verbose.split(/\r?\n/u).some((line) => /^l/u.test(line))) {
    throw new Error("Node archive must not contain symbolic links");
  }
}

async function inspectArchive(archive, expectedSha256) {
  const actualSha256 = await digestFile(archive);
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256))
    throw new Error("Expected archive SHA-256 is invalid");
  if (actualSha256 !== expectedSha256)
    throw new Error("Node archive SHA-256 does not match");
  const names = tarOutput(archive, "-tzf").split(/\r?\n/u).filter(Boolean);
  assertSafeArchiveEntries(names, tarOutput(archive, "-tvzf"));
  const metadata = JSON.parse(
    tarOutput(archive, "-xOzf", "one-fetch/BUILD-METADATA.json"),
  );
  if (
    metadata?.schemaVersion !== 1 ||
    !VERSION_PATTERN.test(metadata.version) ||
    metadata.entrypoint !== "dist/cli.js" ||
    !Number.isInteger(metadata.databaseSchemaVersion)
  ) {
    throw new Error("Node archive build metadata is invalid");
  }
  return { actualSha256, metadata };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Single-host cooperative lock, not an expiring distributed lease. An orphan
// stays fail-closed until an operator has stopped all helpers and recovers it.
export async function withNodeDeploymentLock(rootValue, operation, work) {
  if (!["apply", "resume", "rollback"].includes(operation))
    throw new Error("Invalid deployment lock operation");
  const requestedRoot = safeDeploymentRoot(rootValue);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const root = safeDeploymentRoot(await realpath(requestedRoot));
  const path = join(root, ".deployment-lock.json");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch {
    throw new Error(
      "Deployment is locked or its lock cannot be created; inspect it without deleting an active lock",
    );
  }
  const owner = randomUUID();
  const lock = {
    schemaVersion: 1,
    owner,
    operation,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  let initialized = false;
  const assertOwned = async () => {
    const current = await readJson(path).catch(() => undefined);
    if (current?.schemaVersion !== 1 || current.owner !== owner)
      throw new Error(
        "Deployment lock ownership was lost; stop and inspect state",
      );
  };
  try {
    await handle.writeFile(JSON.stringify(lock) + "\n");
    await handle.sync();
    initialized = true;
    return await work({ root, assertOwned });
  } finally {
    await handle.close();
    // Incomplete initialization or changed ownership is never auto-repaired.
    if (initialized) {
      await assertOwned();
      await unlink(path);
    }
  }
}

async function pointerSnapshot(root) {
  try {
    return await readFile(join(root, "current.json"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertPointerUnchanged(root, snapshot) {
  if ((await pointerSnapshot(root)) !== snapshot)
    throw new Error("Active deployment pointer changed during the operation");
}

async function readCurrent(root) {
  const path = join(root, "current.json");
  if (!(await exists(path))) return undefined;
  const value = await readJson(path);
  if (
    value?.schemaVersion !== 1 ||
    !VERSION_PATTERN.test(value.version) ||
    typeof value.directory !== "string" ||
    value.directory !== `versions/${value.version}` ||
    (value.previousVersion !== undefined &&
      !VERSION_PATTERN.test(value.previousVersion)) ||
    !/^[a-f0-9]{64}$/u.test(value.archiveSha256)
  ) {
    throw new Error("Current deployment pointer is invalid");
  }
  return value;
}

function resolveCurrentDirectory(root, current) {
  const directory = resolve(root, current.directory);
  const relation = relative(root, directory);
  if (relation.startsWith("..") || parse(directory).root === directory)
    throw new Error("Active Node deployment escapes its root");
  return directory;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
}

export async function createNodeDeploymentPlan(options) {
  const root = safeDeploymentRoot(options.root);
  const archive = resolve(options.archive);
  await access(archive);
  const inspected = await inspectArchive(archive, options.sha256);
  const current = await readCurrent(root);
  if (options.expectedVersion === "none") {
    if (current !== undefined)
      throw new Error(`Expected a fresh install, found ${current.version}`);
  } else if (current?.version !== options.expectedVersion) {
    throw new Error(
      `Expected current ${options.expectedVersion}, found ${current?.version ?? "none"}`,
    );
  }
  if (current?.version === inspected.metadata.version)
    throw new Error("Requested version is already active");
  const destination = join(root, "versions", inspected.metadata.version);
  if (await exists(destination))
    throw new Error("Destination version directory already exists");
  return {
    schemaVersion: 1,
    action: current === undefined ? "install" : "update",
    root,
    archive,
    archiveSha256: inspected.actualSha256,
    version: inspected.metadata.version,
    databaseSchemaVersion: inspected.metadata.databaseSchemaVersion,
    previousVersion: current?.version,
    previousArchiveSha256: current?.archiveSha256,
    destination,
    requiresGatewayPause: current !== undefined,
    destructiveDatabaseRestore: false,
  };
}

async function controlRequest(controlUrl, token, path, init = {}) {
  const response = await globalThis.fetch(
    new globalThis.URL(path, controlUrl),
    {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
      cache: "no-store",
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok)
    throw new Error(`Control ${path} failed with HTTP ${response.status}`);
  return response.json();
}

async function inspectInstalledMigrations(directory, expectedVersion) {
  const manifest = await readJson(join(directory, "migration-manifest.json"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.hashAlgorithm !== "sha256" ||
    manifest.migrationsDirectory !== "migrations" ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1 ||
    !Array.isArray(manifest.migrations) ||
    manifest.migrations.length !== expectedVersion
  )
    throw new Error(
      "Installed migration manifest does not match the build schema",
    );
  for (const [index, entry] of manifest.migrations.entries()) {
    if (
      entry.version !== index + 1 ||
      !new RegExp(
        `^${String(index + 1).padStart(4, "0")}_[a-z0-9_]+\\.sql$`,
        "u",
      ).test(entry.file) ||
      !Number.isInteger(entry.bytes) ||
      entry.bytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(entry.artifactSha256)
    )
      throw new Error("Installed migration manifest entry is invalid");
    const sql = await readFile(join(directory, "migrations", entry.file));
    if (
      sql.length !== entry.bytes ||
      createHash("sha256").update(sql).digest("hex") !== entry.artifactSha256
    )
      throw new Error("Installed migration SQL integrity check failed");
  }
  return manifest;
}

async function inspectInstalledDatabase(path, directory, expectedVersion) {
  if (!(await stat(path).catch(() => undefined))?.isFile())
    throw new Error("An existing SQLite database is required for verification");
  const manifest = await inspectInstalledMigrations(directory, expectedVersion);
  const database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  try {
    database.exec("BEGIN");
    if (
      database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
    )
      throw new Error("SQLite integrity_check failed");
    const rows = database
      .prepare(
        "SELECT version, checksum FROM schema_migrations ORDER BY version",
      )
      .all();
    if (
      rows.length !== expectedVersion ||
      rows.some(
        (row, index) =>
          row.version !== index + 1 ||
          row.checksum !== manifest.migrations[index].artifactSha256,
      )
    )
      throw new Error(
        "Applied migration ledger does not match the installed build",
      );
    let identity;
    try {
      identity = JSON.parse(
        database
          .prepare("SELECT value_json FROM instance_config WHERE key = ?")
          .get("configuration")?.value_json,
      );
    } catch {
      throw new Error("Stored instance identity is invalid");
    }
    if (
      [
        identity?.instanceId,
        identity?.controlGatewayPairId,
        identity?.version,
      ].some(
        (value) =>
          typeof value !== "string" || value.length === 0 || value.length > 256,
      )
    )
      throw new Error("Stored instance identity is incomplete");
    return {
      schemaVersion: rows.length,
      instanceId: identity.instanceId,
      controlGatewayPairId: identity.controlGatewayPairId,
      configVersion: identity.version,
    };
  } finally {
    database.close();
  }
}

async function setGatewayPaused(
  controlUrl,
  token,
  paused,
  identity,
  beforeWrite,
) {
  const current = await controlRequest(controlUrl, token, "/api/v1/config");
  if (
    current.instanceId !== identity.instanceId ||
    current.controlGatewayPairId !== identity.controlGatewayPairId ||
    current.version !== identity.configVersion
  )
    throw new Error(
      "Control configuration changed or does not match the verified database",
    );
  if (current.gatewayPaused === paused) return current;
  await beforeWrite();
  const updated = await controlRequest(
    controlUrl,
    token,
    "/api/v1/config/gateway-paused",
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${current.version}"`,
      },
      body: JSON.stringify({ schemaVersion: 1, paused }),
    },
  );
  if (updated.gatewayPaused !== paused)
    throw new Error("Control did not confirm the Gateway pause state");
  return updated;
}

async function backupDatabase(
  sourcePath,
  destinationPath,
  directory,
  expectedVersion,
) {
  await inspectInstalledDatabase(sourcePath, directory, expectedVersion);
  await mkdir(dirname(destinationPath), { recursive: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, destinationPath);
  } finally {
    source.close();
  }
  const identity = await inspectInstalledDatabase(
    destinationPath,
    directory,
    expectedVersion,
  );
  return { sha256: await digestFile(destinationPath), identity };
}

async function extractVersion(plan) {
  await mkdir(join(plan.root, "versions"), { recursive: true });
  const stage = await mkdtemp(join(plan.root, ".one-fetch-stage-"));
  try {
    execFileSync("tar", ["-xzf", plan.archive, "-C", stage], {
      stdio: "inherit",
    });
    const extracted = join(stage, "one-fetch");
    const metadata = await readJson(join(extracted, "BUILD-METADATA.json"));
    if (metadata.version !== plan.version)
      throw new Error("Extracted version does not match deployment plan");
    await rename(extracted, plan.destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function tokenFromFile(path) {
  const token = (await readFile(resolve(path), "utf8")).trim();
  if (token.length < 16) throw new Error("Administrator token file is invalid");
  return token;
}

export async function applyNodeDeployment(options) {
  return withNodeDeploymentLock(options.root, "apply", (lock) =>
    applyNodeDeploymentLocked({ ...options, root: lock.root }, lock),
  );
}

async function applyNodeDeploymentLocked(options, lock) {
  const snapshot = await pointerSnapshot(options.root);
  const beforeWrite = async () => {
    await lock.assertOwned();
    await assertPointerUnchanged(options.root, snapshot);
  };
  const plan = await createNodeDeploymentPlan(options);
  let pause;
  let token;
  let verified;
  if (plan.requiresGatewayPause) {
    if (!options.controlUrl || !options.adminTokenFile)
      throw new Error(
        "Updates require Control URL and administrator token file",
      );
    verified = await verifyNodeDeploymentUnlocked({
      ...options,
      resume: false,
    });
    token = await tokenFromFile(options.adminTokenFile);
    pause = await setGatewayPaused(
      options.controlUrl,
      token,
      true,
      verified.identity,
      beforeWrite,
    );
  }
  const activatedAt = new Date().toISOString();
  let backupRecord;
  if (plan.requiresGatewayPause) {
    const database = resolve(
      options.database ?? join(plan.root, "data", "one-fetch.sqlite"),
    );
    const backupPath = join(
      plan.root,
      "backups",
      activatedAt.replaceAll(":", "-"),
      basename(database),
    );
    const backedUp = await backupDatabase(
      database,
      backupPath,
      join(plan.root, "versions", plan.previousVersion),
      verified.databaseSchemaVersion,
    );
    if (
      backedUp.identity.instanceId !== verified.identity.instanceId ||
      backedUp.identity.controlGatewayPairId !==
        verified.identity.controlGatewayPairId ||
      backedUp.identity.configVersion !== pause.version
    )
      throw new Error(
        "Backup identity does not match the confirmed paused instance",
      );
    backupRecord = {
      path: relative(plan.root, backupPath).replaceAll("\\", "/"),
      sha256: backedUp.sha256,
      schemaVersion: backedUp.identity.schemaVersion,
    };
  }
  await beforeWrite();
  await extractVersion(plan);
  const migrations = await inspectInstalledMigrations(
    plan.destination,
    plan.databaseSchemaVersion,
  );
  if (verified) {
    const previous = await inspectInstalledMigrations(
      join(plan.root, "versions", plan.previousVersion),
      verified.databaseSchemaVersion,
    );
    if (
      migrations.migrations.length < previous.migrations.length ||
      previous.migrations.some(
        (entry, index) =>
          entry.artifactSha256 !== migrations.migrations[index]?.artifactSha256,
      )
    )
      throw new Error("Update would remove or rewrite an applied migration");
  }
  const pointer = {
    schemaVersion: 1,
    version: plan.version,
    directory: relative(plan.root, plan.destination).replaceAll("\\", "/"),
    archiveSha256: plan.archiveSha256,
    activatedAt,
    ...(plan.previousVersion ? { previousVersion: plan.previousVersion } : {}),
    ...(plan.previousArchiveSha256
      ? { previousArchiveSha256: plan.previousArchiveSha256 }
      : {}),
  };
  await beforeWrite();
  await writeJsonAtomic(join(plan.root, "current.json"), pointer);
  const journal = {
    schemaVersion: 1,
    state: "restart-required",
    action: plan.action,
    version: plan.version,
    previousVersion: plan.previousVersion,
    activatedAt,
    gatewayPaused: Boolean(pause?.gatewayPaused),
    configVersion: pause?.version,
    backup: backupRecord,
    recovery: {
      automaticDatabaseRestore: false,
      previousArtifactRetained: plan.previousVersion !== undefined,
    },
  };
  await writeJsonAtomic(
    join(plan.root, "journal", `${activatedAt.replaceAll(":", "-")}.json`),
    journal,
  );
  return { ...journal, root: plan.root, current: pointer };
}

export async function verifyNodeDeployment(options) {
  if (options.resume === true)
    return withNodeDeploymentLock(options.root, "resume", (lock) =>
      verifyNodeDeploymentUnlocked({ ...options, root: lock.root }, lock),
    );
  return verifyNodeDeploymentUnlocked(options);
}

async function verifyNodeDeploymentUnlocked(options, lock) {
  const root = safeDeploymentRoot(options.root);
  const snapshot = await pointerSnapshot(root);
  const beforeWrite = async () => {
    await lock?.assertOwned();
    await assertPointerUnchanged(root, snapshot);
  };
  const current = await readCurrent(root);
  if (!current) throw new Error("No active Node deployment exists");
  const directory = resolveCurrentDirectory(root, current);
  const metadata = await readJson(join(directory, "BUILD-METADATA.json"));
  if (
    metadata.schemaVersion !== 1 ||
    metadata.entrypoint !== "dist/cli.js" ||
    metadata.version !== current.version
  )
    throw new Error("Active build metadata does not match current pointer");
  const database = resolve(
    options.database ?? join(root, "data", "one-fetch.sqlite"),
  );
  const identity = await inspectInstalledDatabase(
    database,
    directory,
    metadata.databaseSchemaVersion,
  );
  let capabilities;
  if (options.controlUrl) {
    const response = await globalThis.fetch(
      new globalThis.URL("/api/v1/capabilities", options.controlUrl),
      {
        cache: "no-store",
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new Error(`Capabilities failed with HTTP ${response.status}`);
    capabilities = await response.json();
    if (capabilities.buildVersion !== current.version)
      throw new Error("Running Control build does not match current pointer");
    if (
      capabilities.protocolVersion !== 1 ||
      capabilities.provider !== "node" ||
      capabilities.instanceId !== identity.instanceId ||
      capabilities.controlGatewayPairId !== identity.controlGatewayPairId ||
      capabilities.configVersion !== identity.configVersion
    )
      throw new Error(
        "Running Control identity does not match the selected database",
      );
  }
  if (options.resume === true) {
    if (!options.controlUrl || !options.adminTokenFile)
      throw new Error(
        "Resume requires Control URL and administrator token file",
      );
    await setGatewayPaused(
      options.controlUrl,
      await tokenFromFile(options.adminTokenFile),
      false,
      identity,
      beforeWrite,
    );
  }
  await beforeWrite();
  return {
    schemaVersion: 1,
    state: capabilities ? "verified" : "offline-verified",
    version: current.version,
    databaseSchemaVersion: identity.schemaVersion,
    runtimeVerified: Boolean(capabilities),
    runningBuildVersion: capabilities?.buildVersion,
    gatewayResumed: options.resume === true,
    identity,
  };
}

export async function rollbackNodeDeployment(options) {
  return withNodeDeploymentLock(options.root, "rollback", (lock) =>
    rollbackNodeDeploymentLocked({ ...options, root: lock.root }, lock),
  );
}

async function rollbackNodeDeploymentLocked(options, lock) {
  const root = safeDeploymentRoot(options.root);
  const snapshot = await pointerSnapshot(root);
  const beforeWrite = async () => {
    await lock.assertOwned();
    await assertPointerUnchanged(root, snapshot);
  };
  const current = await readCurrent(root);
  if (!current || current.version !== options.expectedVersion)
    throw new Error("Rollback expected version does not match current pointer");
  if (!current.previousVersion)
    throw new Error("No previous version is recorded");
  if (!/^[a-f0-9]{64}$/u.test(current.previousArchiveSha256 ?? ""))
    throw new Error("Previous archive digest is not recorded");
  if (!options.controlUrl || !options.adminTokenFile)
    throw new Error("Rollback requires paused Control verification");
  const verified = await verifyNodeDeploymentUnlocked({
    ...options,
    resume: false,
  });
  const previousDirectory = join(root, "versions", current.previousVersion);
  const previous = await readJson(
    join(previousDirectory, "BUILD-METADATA.json"),
  );
  if (
    previous.schemaVersion !== 1 ||
    previous.version !== current.previousVersion ||
    previous.entrypoint !== "dist/cli.js"
  )
    throw new Error(
      "Previous build metadata does not match the rollback pointer",
    );
  const database = resolve(
    options.database ?? join(root, "data", "one-fetch.sqlite"),
  );
  if (verified.databaseSchemaVersion !== previous.databaseSchemaVersion) {
    throw new Error(
      "Previous code cannot use the migrated database; restore an isolated backup explicitly",
    );
  }
  await inspectInstalledDatabase(
    database,
    previousDirectory,
    previous.databaseSchemaVersion,
  );
  const token = await tokenFromFile(options.adminTokenFile);
  await setGatewayPaused(
    options.controlUrl,
    token,
    true,
    verified.identity,
    beforeWrite,
  );
  await beforeWrite();
  await writeJsonAtomic(join(root, "current.json"), {
    schemaVersion: 1,
    version: current.previousVersion,
    directory: `versions/${current.previousVersion}`,
    archiveSha256: current.previousArchiveSha256,
    activatedAt: new Date().toISOString(),
    previousVersion: current.version,
    previousArchiveSha256: current.archiveSha256,
  });
  return {
    schemaVersion: 1,
    state: "restart-required",
    version: current.previousVersion,
    databaseRestored: false,
    gatewayPaused: true,
  };
}

async function launch(rootValue) {
  const root = safeDeploymentRoot(rootValue);
  const current = await readCurrent(root);
  if (!current) throw new Error("No active Node deployment exists");
  const entrypoint = join(
    resolveCurrentDirectory(root, current),
    "dist",
    "cli.js",
  );
  await import(pathToFileURL(entrypoint).href);
}

async function main() {
  assertDeploymentRuntime();
  const argumentsMap = parseArguments(process.argv.slice(2));
  const mode = required(argumentsMap, "--mode");
  const common = {
    root: required(argumentsMap, "--root"),
    database: argumentsMap.get("--database"),
    controlUrl: argumentsMap.get("--control-url"),
    adminTokenFile: argumentsMap.get("--admin-token-file"),
    resume: argumentsMap.get("--resume") === true,
  };
  if (mode === "launch") return launch(common.root);
  let result;
  if (mode === "plan" || mode === "apply") {
    const options = {
      ...common,
      archive: required(argumentsMap, "--archive"),
      sha256: required(argumentsMap, "--sha256"),
      expectedVersion: required(argumentsMap, "--expected-version"),
    };
    result =
      mode === "plan"
        ? await createNodeDeploymentPlan(options)
        : await applyNodeDeployment(options);
  } else if (mode === "verify") {
    result = await verifyNodeDeployment(common);
  } else if (mode === "rollback") {
    result = await rollbackNodeDeployment({
      ...common,
      expectedVersion: required(argumentsMap, "--expected-version"),
    });
  } else {
    throw new Error(`Unsupported deployment mode ${mode}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        state: "failed",
        message: error instanceof Error ? error.message : "Deployment failed",
        recovery:
          "Keep Gateway paused, inspect current.json and the deployment journal, and never restore a database in place automatically.",
      })}\n`,
    );
    process.exitCode = 1;
  }
}
