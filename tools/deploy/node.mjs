import process from "node:process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readCurrent,
  resolveCurrentDirectory,
  safeDeploymentRoot,
} from "./node-files.mjs";
import { createNodeDeploymentPlan } from "./node-archive.mjs";
import {
  applyNodeDeployment,
  rollbackNodeDeployment,
  verifyNodeDeployment,
} from "./node-operations.mjs";

export { safeDeploymentRoot, withNodeDeploymentLock } from "./node-files.mjs";
export {
  assertSafeArchiveEntries,
  createNodeDeploymentPlan,
} from "./node-archive.mjs";
export {
  applyNodeDeployment,
  rollbackNodeDeployment,
  verifyNodeDeployment,
} from "./node-operations.mjs";

const MINIMUM_NODE = [24, 20, 0];

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
