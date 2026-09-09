import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  assertHostedDeployment,
  buildId,
  readDeploymentEnvironment,
} from "./deploy-support.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const envFile = option("--env-file");
const projectRef = option("--project-ref");
if (!envFile || !projectRef) {
  throw new Error("Usage: build-id.mjs --project-ref <ref> --env-file <path>");
}
assertHostedDeployment(await readDeploymentEnvironment(envFile), projectRef);

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const status = execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=normal"],
  { cwd: repositoryRoot, encoding: "utf8" },
);
if (status.trim()) {
  throw new Error(
    "Refusing to deploy a dirty tree because its commit build ID would be misleading",
  );
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const manifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
);
process.stdout.write(`${buildId(manifest.version, commit)}\n`);
