import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  digestFile,
  exists,
  readCurrent,
  readJson,
  safeDeploymentRoot,
} from "./node-files.mjs";
const VERSION_PATTERN = /^0\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u;

export function tarOutput(archive, ...arguments_) {
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

export async function inspectArchive(archive, expectedSha256) {
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

export async function extractVersion(plan) {
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
