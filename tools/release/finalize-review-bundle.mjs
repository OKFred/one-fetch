import console from "node:console";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { nodeDistributionFilenames } from "./build-node-distribution.mjs";
import {
  basename,
  defaultOutputRoot,
  digestFile,
  git,
  gitWorktreeStatus,
  join,
  listFiles,
  parseArguments,
  readJson,
  releaseDirectory,
  repositoryRoot,
  requireReleaseChannel,
  writeFile,
  writeJson,
} from "./lib.mjs";

export function requiredReviewArtifactFilenames(
  version,
  { requireOci = false, requireOciSbom = false, requireSbom = false } = {},
) {
  const nodeFiles = nodeDistributionFilenames(version);
  const filenames = [
    `one-fetch-protocol-${version}.tgz`,
    `one-fetch-core-${version}.tgz`,
    `one-fetch-client-${version}.tgz`,
    `one-fetch-types-${version}.tgz`,
    `one-fetch-protocol-schemas-${version}.json`,
    `one-fetch-control-openapi-${version}.json`,
    nodeFiles.archive,
    nodeFiles.dockerfile,
    nodeFiles.dockerignore,
    nodeFiles.deploy,
    nodeFiles.metadata,
    `one-fetch-admin-${version}.zip`,
  ];
  if (requireSbom) filenames.push(`one-fetch-sbom-${version}.cdx.json`);
  if (requireOci) filenames.push(`one-fetch-node-${version}.oci.tar`);
  if (requireOciSbom) {
    filenames.push(`one-fetch-node-oci-${version}.cdx.json`);
  }
  return filenames;
}

export async function assertRequiredReviewArtifacts(
  outputDirectory,
  filenames,
) {
  const invalid = [];
  for (const filename of filenames) {
    const details = await stat(join(outputDirectory, filename)).catch(
      () => undefined,
    );
    if (!details?.isFile() || details.size === 0) invalid.push(filename);
  }
  if (invalid.length > 0) {
    throw new Error(
      `Required review artifacts are missing, empty, or not files: ${invalid.join(", ")}`,
    );
  }
}

export async function finalizeReviewBundle(argv = process.argv.slice(2)) {
  const argumentsMap = parseArguments(argv);
  const rootManifest = await readJson(join(repositoryRoot, "package.json"));
  const versionArgument =
    argumentsMap.get("version") === true ||
    argumentsMap.get("version") === undefined
      ? rootManifest.version
      : argumentsMap.get("version");
  const { channel, version } = requireReleaseChannel(
    versionArgument,
    argumentsMap.get("channel") ?? "preview",
  );
  const outputRoot =
    argumentsMap.get("output") === true ||
    argumentsMap.get("output") === undefined
      ? defaultOutputRoot
      : argumentsMap.get("output");
  const outputDirectory = releaseDirectory(version, outputRoot);
  const requiredArtifacts = requiredReviewArtifactFilenames(version, {
    requireOci: argumentsMap.has("require-oci"),
    requireOciSbom: argumentsMap.has("require-oci-sbom"),
    requireSbom: argumentsMap.has("require-sbom"),
  });
  await assertRequiredReviewArtifacts(outputDirectory, requiredArtifacts);

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
  const dirty = gitWorktreeStatus().length > 0;
  if (channel === "stable" && dirty) {
    throw new Error("Stable review artifacts require a clean worktree");
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
  return { artifacts, manifestFilename, outputDirectory };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await finalizeReviewBundle();
}
