import console from "node:console";
import { copyFile, lstat, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createDeterministicTarGzip } from "./deterministic-tar.mjs";
import {
  assertInsideRepository,
  defaultOutputRoot,
  digestFile,
  git,
  gitWorktreeStatus,
  makeTemporaryDirectory,
  parseArguments,
  readFile,
  readJson,
  releaseDirectory,
  repositoryRoot,
  requireVersion,
  writeJson,
} from "./lib.mjs";
import {
  assertPortableDistributionTree,
  materializePortableNodeModules,
} from "./portable-node-modules.mjs";
import { runSharedPnpmDeploy } from "./pnpm-shared-deploy.mjs";

const adapterDirectory = join(repositoryRoot, "adapters", "node");
const dockerfilePath = join(adapterDirectory, "Dockerfile");
const ociConfigurationPath = join(adapterDirectory, "oci-build.json");
const deploymentScriptPath = join(
  repositoryRoot,
  "tools",
  "deploy",
  "node.mjs",
);
const archiveRoot = "one-fetch";

export function nodeDistributionFilenames(version) {
  const checkedVersion = requireVersion(version);
  return {
    archive: `one-fetch-node-${checkedVersion}.tar.gz`,
    dockerfile: `one-fetch-node-${checkedVersion}.Dockerfile`,
    dockerignore: `one-fetch-node-${checkedVersion}.Dockerfile.dockerignore`,
    deploy: `one-fetch-node-deploy-${checkedVersion}.mjs`,
    metadata: `one-fetch-node-oci-${checkedVersion}.json`,
  };
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function validateNodeOciConfiguration(configuration, dockerfile) {
  if (configuration?.schemaVersion !== 1) {
    throw new Error("Node OCI configuration schemaVersion must be 1");
  }
  if (configuration.archive?.rootDirectory !== archiveRoot) {
    throw new Error(`Node archive root must be ${archiveRoot}`);
  }
  const frontendDigest = assertDigest(
    configuration.frontend?.indexDigest,
    "Node Dockerfile frontend index",
  );
  if (
    configuration.frontend?.reference !==
    `${configuration.frontend.tag}@${frontendDigest}`
  ) {
    throw new Error(
      "Node Dockerfile frontend reference must bind its tag to the index digest",
    );
  }
  if (
    dockerfile.split(/\r?\n/u)[0] !==
    `# syntax=${configuration.frontend.reference}`
  ) {
    throw new Error("Node Dockerfile frontend does not match oci-build.json");
  }
  const digest = assertDigest(
    configuration.baseImage?.indexDigest,
    "Node OCI base image index",
  );
  if (
    configuration.baseImage?.reference !==
    `${configuration.baseImage.tag}@${digest}`
  ) {
    throw new Error(
      "Node OCI base image reference must bind its tag to the index digest",
    );
  }
  const fromDirectives = dockerfile.match(/^FROM\s+.+$/gmu) ?? [];
  if (
    fromDirectives.length !== 1 ||
    fromDirectives[0] !== `FROM ${configuration.baseImage.reference}`
  ) {
    throw new Error("Node Dockerfile FROM does not match oci-build.json");
  }
  const addOffset = dockerfile.indexOf("ADD one-fetch-node-");
  const userOffset = dockerfile.lastIndexOf("USER node");
  const entrypointOffset = dockerfile.indexOf("ENTRYPOINT");
  if (
    addOffset < 0 ||
    userOffset < addOffset ||
    entrypointOffset < userOffset
  ) {
    throw new Error(
      "Node Dockerfile must run the extracted archive as the non-root node user",
    );
  }
  const userDirectives = dockerfile.match(/^USER\s+.+$/gmu) ?? [];
  if (userDirectives.at(-1) !== "USER node") {
    throw new Error("Node Dockerfile final runtime user must be node");
  }
  if (configuration.runtime?.nodeVersion !== "24.20.0") {
    throw new Error("Node OCI runtime must stay on the 24.20.0 baseline");
  }
  if (configuration.runtime?.user !== "node") {
    throw new Error("Node OCI runtime user must be node");
  }
  const platforms = configuration.build?.platforms;
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error("Node OCI build platforms must have pinned manifests");
  }
  if (configuration.build?.contextTemplate !== "artifacts/release/{version}") {
    throw new Error("Node OCI context must be the release-version directory");
  }
  for (const platform of platforms) {
    if (typeof platform !== "string") {
      throw new Error("Node OCI build platform names must be strings");
    }
    assertDigest(
      configuration.baseImage?.platformManifests?.[platform],
      `Node OCI platform ${platform}`,
    );
  }
  return configuration;
}

function runtimeDependencies(dependencies, version) {
  return Object.fromEntries(
    Object.entries(dependencies ?? {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => [
        name,
        typeof value === "string" && value.startsWith("workspace:")
          ? version
          : value,
      ]),
  );
}

export function normalizeInternalRuntimeManifest(manifest, version) {
  const normalized = {
    name: manifest.name,
    version,
    private: true,
    type: "module",
    license: manifest.license,
    exports: manifest.exports,
  };
  const dependencies = runtimeDependencies(manifest.dependencies, version);
  if (Object.keys(dependencies).length > 0)
    normalized.dependencies = dependencies;
  const optional = runtimeDependencies(manifest.optionalDependencies, version);
  if (Object.keys(optional).length > 0)
    normalized.optionalDependencies = optional;
  return normalized;
}

async function pruneRuntimeBuild(directory, keepDeclarations = false) {
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (
        entry.name === ".tsbuildinfo" ||
        entry.name === "test-helpers.js" ||
        entry.name.endsWith(".d.ts.map") ||
        (!keepDeclarations && entry.name.endsWith(".d.ts")) ||
        entry.name.includes(".test.")
      ) {
        await rm(path, { force: true });
      }
    }
  }
  await visit(directory);
}

async function normalizeInternalRuntimePackage(directory, version) {
  const manifestPath = join(directory, "package.json");
  await writeJson(
    manifestPath,
    normalizeInternalRuntimeManifest(await readJson(manifestPath), version),
  );
  await pruneRuntimeBuild(join(directory, "dist"), true);
}

async function exists(path) {
  return Boolean(await lstat(path).catch(() => undefined));
}

async function listTreeNames(directory) {
  const result = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      result.push(entry.name);
      if (entry.isDirectory()) await visit(join(current, entry.name));
    }
  }
  await visit(directory);
  return result;
}

async function validateDeploymentTree(directory, version) {
  const requiredPaths = [
    ".env.example",
    "BUILD-METADATA.json",
    "LICENSE",
    "README.md",
    "dist/cli.js",
    "dist/database-worker.js",
    "migration-manifest.json",
    "migrations/0001_initial.sql",
    "node_modules/@one-fetch/core/dist/index.js",
    "node_modules/@one-fetch/protocol/dist/index.js",
    "node_modules/hono/package.json",
    "package.json",
  ];
  for (const path of requiredPaths) {
    if (!(await exists(join(directory, path)))) {
      throw new Error(`Node deployment is missing ${path}`);
    }
  }
  for (const path of ["src", "scripts", "tsconfig.json", "vitest.config.ts"]) {
    if (await exists(join(directory, path))) {
      throw new Error(`Node deployment contains development input ${path}`);
    }
  }
  for (const path of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "node_modules/.modules.yaml",
    "node_modules/.package-map.json",
    "node_modules/.pnpm",
    "node_modules.pnpm-source",
    "node_modules.portable",
  ]) {
    if (await exists(join(directory, path))) {
      throw new Error(`Node deployment still contains pnpm state ${path}`);
    }
  }
  const manifest = await readJson(join(directory, "package.json"));
  if (
    manifest.version !== version ||
    manifest.engines?.node !== ">=24.20.0 <27"
  ) {
    throw new Error(
      "Node deployment manifest does not match the runtime baseline",
    );
  }
  if (
    manifest.devDependencies ||
    manifest.dependencies?.["@one-fetch/core"] !== version
  ) {
    throw new Error(
      "Node deployment manifest still contains workspace-only metadata",
    );
  }
  for (const [name, expectedVersion] of Object.entries(
    manifest.dependencies ?? {},
  )) {
    const installed = await readJson(
      join(directory, "node_modules", name, "package.json"),
    );
    if (installed.version !== expectedVersion) {
      throw new Error(
        `Node production dependency ${name} is ${installed.version}, expected ${expectedVersion}`,
      );
    }
  }
  for (const name of ["core", "protocol"]) {
    const packageDirectory = join(
      directory,
      "node_modules",
      "@one-fetch",
      name,
    );
    const internal = await readJson(join(packageDirectory, "package.json"));
    if (
      internal.version !== version ||
      internal.devDependencies ||
      internal.scripts ||
      internal.packageManager ||
      JSON.stringify(internal).includes("workspace:")
    ) {
      throw new Error(
        `Internal runtime package ${name} has development metadata`,
      );
    }
    const names = await listTreeNames(join(packageDirectory, "dist"));
    if (
      names.some(
        (entry) => entry === ".tsbuildinfo" || entry.endsWith(".d.ts.map"),
      )
    ) {
      throw new Error(`Internal runtime package ${name} has build metadata`);
    }
  }
}

async function stageNodeDeployment(directory, version) {
  const source = await readJson(join(adapterDirectory, "package.json"));
  const migrationManifest = await readJson(
    join(adapterDirectory, "migration-manifest.json"),
  );
  const workspace = await runSharedPnpmDeploy({
    destinationDirectory: directory,
    workspaceDirectory: repositoryRoot,
  });
  await materializePortableNodeModules(join(directory, "node_modules"), {
    expectedStoreDir: workspace.storeDir,
    workspaceDirectory: repositoryRoot,
  });
  await Promise.all(
    ["pnpm-lock.yaml", "pnpm-workspace.yaml"].map((path) =>
      rm(join(directory, path), { force: true }),
    ),
  );
  await pruneRuntimeBuild(join(directory, "dist"));
  await Promise.all(
    ["core", "protocol"].map((name) =>
      normalizeInternalRuntimePackage(
        join(directory, "node_modules", "@one-fetch", name),
        version,
      ),
    ),
  );

  const dependencies = runtimeDependencies(source.dependencies, version);
  await writeJson(join(directory, "package.json"), {
    name: source.name,
    version,
    private: true,
    type: "module",
    description: source.description,
    license: source.license,
    engines: source.engines,
    exports: source.exports,
    bin: source.bin,
    scripts: { start: "node dist/cli.js" },
    dependencies,
    bundledDependencies: Object.keys(dependencies),
    oneFetchDistribution: {
      schemaVersion: 1,
      kind: "portable-node-esm",
      installDependencies: false,
    },
  });
  await copyFile(join(repositoryRoot, "LICENSE"), join(directory, "LICENSE"));
  await writeJson(join(directory, "BUILD-METADATA.json"), {
    schemaVersion: 1,
    version,
    format: "portable-node-esm",
    node: source.engines.node,
    entrypoint: "dist/cli.js",
    databaseSchemaVersion: migrationManifest.migrations.length,
    dependenciesIncluded: true,
    lockfileSha256: await digestFile(
      join(repositoryRoot, "pnpm-lock.yaml"),
      "sha256",
    ),
    archiveRoot,
  });
  await assertPortableDistributionTree(directory, [
    repositoryRoot,
    workspace.storeDir,
    resolve(directory, ".."),
  ]);
  await validateDeploymentTree(directory, version);
}

async function readValidatedOciConfiguration() {
  return validateNodeOciConfiguration(
    await readJson(ociConfigurationPath),
    await readFile(dockerfilePath, "utf8"),
  );
}

export async function buildNodeDistribution(outputDirectory, version) {
  const checkedVersion = requireVersion(version);
  const safeOutputDirectory = assertInsideRepository(outputDirectory);
  const sourceManifest = await readJson(join(adapterDirectory, "package.json"));
  if (sourceManifest.version !== checkedVersion) {
    throw new Error(
      `Node adapter version ${sourceManifest.version} does not match ${checkedVersion}`,
    );
  }
  if (!(await exists(join(adapterDirectory, "dist", "cli.js")))) {
    throw new Error(
      "Node adapter dist is missing; build the workspace before packaging",
    );
  }
  const configuration = await readValidatedOciConfiguration();
  const filenames = nodeDistributionFilenames(checkedVersion);
  const temporaryRoot = await makeTemporaryDirectory("one-fetch-node-release-");
  try {
    const deploymentDirectory = join(temporaryRoot, archiveRoot);
    await stageNodeDeployment(deploymentDirectory, checkedVersion);
    const commitTime = Math.floor(
      Date.parse(git("show", "-s", "--format=%cI", "HEAD")) / 1_000,
    );
    await createDeterministicTarGzip({
      sourceDirectory: deploymentDirectory,
      outputFile: join(safeOutputDirectory, filenames.archive),
      rootName: archiveRoot,
      mtime: commitTime,
      executablePaths: ["dist/cli.js"],
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const versionedDockerfile = join(safeOutputDirectory, filenames.dockerfile);
  await copyFile(dockerfilePath, versionedDockerfile);
  const versionedDockerignore = join(
    safeOutputDirectory,
    filenames.dockerignore,
  );
  await writeFile(versionedDockerignore, `*\n!${filenames.archive}\n`, "utf8");
  const versionedDeploy = join(safeOutputDirectory, filenames.deploy);
  await copyFile(deploymentScriptPath, versionedDeploy);
  const commit = git("rev-parse", "HEAD");
  await writeJson(join(safeOutputDirectory, filenames.metadata), {
    schemaVersion: 1,
    version: checkedVersion,
    source: {
      repository: "https://github.com/OKFred/one-fetch",
      commit,
      dirty: gitWorktreeStatus().length > 0,
      lockfileSha256: await digestFile(
        join(repositoryRoot, "pnpm-lock.yaml"),
        "sha256",
      ),
    },
    archive: {
      filename: filenames.archive,
      rootDirectory: archiveRoot,
      sha256: await digestFile(
        join(safeOutputDirectory, filenames.archive),
        "sha256",
      ),
    },
    dockerfile: {
      filename: filenames.dockerfile,
      sha256: await digestFile(versionedDockerfile, "sha256"),
    },
    dockerignore: {
      filename: filenames.dockerignore,
      sha256: await digestFile(versionedDockerignore, "sha256"),
    },
    deploymentHelper: {
      filename: filenames.deploy,
      sha256: await digestFile(versionedDeploy, "sha256"),
    },
    frontend: configuration.frontend,
    baseImage: configuration.baseImage,
    build: {
      context: ".",
      platforms: configuration.build.platforms,
      arguments: { ONE_FETCH_VERSION: checkedVersion, VCS_REF: commit },
      output: configuration.build.recommendedOutput,
    },
    runtime: configuration.runtime,
  });
  return [
    filenames.archive,
    filenames.dockerfile,
    filenames.dockerignore,
    filenames.deploy,
    filenames.metadata,
  ];
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const rootManifest = await readJson(join(repositoryRoot, "package.json"));
  const version =
    argumentsMap.get("version") === true ||
    argumentsMap.get("version") === undefined
      ? rootManifest.version
      : argumentsMap.get("version");
  const outputRoot =
    argumentsMap.get("output") === true ||
    argumentsMap.get("output") === undefined
      ? defaultOutputRoot
      : argumentsMap.get("output");
  const outputDirectory = releaseDirectory(version, outputRoot);
  const files = await buildNodeDistribution(outputDirectory, version);
  console.log(files.join("\n"));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
