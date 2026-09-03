import console from "node:console";
import { stat } from "node:fs/promises";
import process from "node:process";

import {
  basename,
  defaultOutputRoot,
  digestFile,
  git,
  join,
  listFiles,
  parseArguments,
  readJson,
  releaseDirectory,
  repositoryRoot,
  writeFile,
  writeJson,
} from "./lib.mjs";

const argumentsMap = parseArguments(process.argv.slice(2));
const rootManifest = await readJson(join(repositoryRoot, "package.json"));
const version =
  argumentsMap.get("version") === true ||
  argumentsMap.get("version") === undefined
    ? rootManifest.version
    : argumentsMap.get("version");
const channel = argumentsMap.get("channel") ?? "preview";
if (!new Set(["preview", "stable"]).has(channel)) {
  throw new Error(`Channel must be preview or stable, received ${channel}`);
}
const outputRoot =
  argumentsMap.get("output") === true ||
  argumentsMap.get("output") === undefined
    ? defaultOutputRoot
    : argumentsMap.get("output");
const outputDirectory = releaseDirectory(version, outputRoot);
const requireSbom = argumentsMap.get("require-sbom") === true;
const sbomFilename = `one-fetch-sbom-${version}.cdx.json`;

if (
  requireSbom &&
  !(await stat(join(outputDirectory, sbomFilename)).catch(() => undefined))
) {
  throw new Error(`Required SBOM is missing: ${sbomFilename}`);
}

const manifestFilename = `one-fetch-release-manifest-${version}.json`;
const excluded = new Set([manifestFilename, "SHA256SUMS", "SHA512SUMS"]);
const artifactPaths = (await listFiles(outputDirectory)).filter(
  (path) => !excluded.has(basename(path)),
);
const artifacts = [];
for (const path of artifactPaths) {
  artifacts.push({
    name: basename(path),
    bytes: (await stat(path)).size,
    sha256: await digestFile(path, "sha256"),
    sha512: await digestFile(path, "sha512"),
  });
}

const commit = git("rev-parse", "HEAD");
const commitTime = git("show", "-s", "--format=%cI", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=no").length > 0;
if (channel === "stable" && dirty) {
  throw new Error("Stable review artifacts require a clean tracked worktree");
}
await writeJson(join(outputDirectory, manifestFilename), {
  schemaVersion: 1,
  version,
  channel,
  protocolVersion: 1,
  generatedAt: commitTime,
  source: {
    repository: "https://github.com/OKFred/one-fetch",
    commit,
    ref: process.env.GITHUB_REF ?? null,
    dirty,
  },
  distribution: {
    npmPublished: false,
    deploysAdapters: false,
    createsRelease: false,
  },
  artifacts,
});

const checksumPaths = (await listFiles(outputDirectory)).filter(
  (path) => !new Set(["SHA256SUMS", "SHA512SUMS"]).has(basename(path)),
);
for (const algorithm of ["sha256", "sha512"]) {
  const lines = [];
  for (const path of checksumPaths) {
    lines.push(`${await digestFile(path, algorithm)}  ${basename(path)}`);
  }
  await writeFile(
    join(outputDirectory, `${algorithm.toUpperCase()}SUMS`),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

console.log(
  `Finalized ${artifacts.length} subjects for ${version} (${channel})`,
);
