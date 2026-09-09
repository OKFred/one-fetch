import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
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

async function readCurrent(root) {
  const path = join(root, "current.json");
  if (!(await exists(path))) return undefined;
  const value = await readJson(path);
  if (
    value?.schemaVersion !== 1 ||
    !VERSION_PATTERN.test(value.version) ||
    typeof value.directory !== "string" ||
    !value.directory.startsWith("versions/") ||
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
    },
  );
  if (!response.ok)
    throw new Error(`Control ${path} failed with HTTP ${response.status}`);
  return response.json();
}

async function setGatewayPaused(controlUrl, token, paused) {
  const current = await controlRequest(controlUrl, token, "/api/v1/config");
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

function checkDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok")
      throw new Error("SQLite integrity_check failed");
    const migration = database
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
      .get();
    if (!Number.isInteger(migration?.version))
      throw new Error("SQLite migration ledger is invalid");
    return migration.version;
  } finally {
    database.close();
  }
}

async function backupDatabase(sourcePath, destinationPath) {
  checkDatabase(sourcePath);
  await mkdir(dirname(destinationPath), { recursive: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, destinationPath);
  } finally {
    source.close();
  }
  checkDatabase(destinationPath);
  return digestFile(destinationPath);
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
  const plan = await createNodeDeploymentPlan(options);
  let pause;
  let token;
  if (plan.requiresGatewayPause) {
    if (!options.controlUrl || !options.adminTokenFile)
      throw new Error(
        "Updates require Control URL and administrator token file",
      );
    token = await tokenFromFile(options.adminTokenFile);
    pause = await setGatewayPaused(options.controlUrl, token, true);
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
    backupRecord = {
      path: relative(plan.root, backupPath).replaceAll("\\", "/"),
      sha256: await backupDatabase(database, backupPath),
      schemaVersion: checkDatabase(backupPath),
    };
  }
  await extractVersion(plan);
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
  const root = safeDeploymentRoot(options.root);
  const current = await readCurrent(root);
  if (!current) throw new Error("No active Node deployment exists");
  const directory = resolveCurrentDirectory(root, current);
  const metadata = await readJson(join(directory, "BUILD-METADATA.json"));
  if (metadata.version !== current.version)
    throw new Error("Active build metadata does not match current pointer");
  const database = resolve(
    options.database ?? join(root, "data", "one-fetch.sqlite"),
  );
  const databaseSchemaVersion = (await exists(database))
    ? checkDatabase(database)
    : 0;
  let capabilities;
  if (options.controlUrl) {
    const response = await globalThis.fetch(
      new globalThis.URL("/api/v1/capabilities", options.controlUrl),
      {
        cache: "no-store",
      },
    );
    if (!response.ok)
      throw new Error(`Capabilities failed with HTTP ${response.status}`);
    capabilities = await response.json();
    if (capabilities.buildVersion !== current.version)
      throw new Error("Running Control build does not match current pointer");
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
    );
  }
  return {
    schemaVersion: 1,
    state: "verified",
    version: current.version,
    databaseSchemaVersion,
    runningBuildVersion: capabilities?.buildVersion,
    gatewayResumed: options.resume === true,
  };
}

export async function rollbackNodeDeployment(options) {
  const root = safeDeploymentRoot(options.root);
  const current = await readCurrent(root);
  if (!current || current.version !== options.expectedVersion)
    throw new Error("Rollback expected version does not match current pointer");
  if (!current.previousVersion)
    throw new Error("No previous version is recorded");
  if (!/^[a-f0-9]{64}$/u.test(current.previousArchiveSha256 ?? ""))
    throw new Error("Previous archive digest is not recorded");
  if (!options.controlUrl || !options.adminTokenFile)
    throw new Error("Rollback requires paused Control verification");
  const token = await tokenFromFile(options.adminTokenFile);
  await setGatewayPaused(options.controlUrl, token, true);
  const previousDirectory = join(root, "versions", current.previousVersion);
  const previous = await readJson(
    join(previousDirectory, "BUILD-METADATA.json"),
  );
  const database = resolve(
    options.database ?? join(root, "data", "one-fetch.sqlite"),
  );
  const databaseSchemaVersion = checkDatabase(database);
  if (databaseSchemaVersion > previous.databaseSchemaVersion) {
    throw new Error(
      "Previous code cannot use the migrated database; restore an isolated backup explicitly",
    );
  }
  await writeJsonAtomic(join(root, "current.json"), {
    schemaVersion: 1,
    version: current.previousVersion,
    directory: `versions/${current.previousVersion}`,
    archiveSha256: current.previousArchiveSha256,
    activatedAt: new Date().toISOString(),
    previousVersion: current.version,
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
