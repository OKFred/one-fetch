import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import { readJson, run } from "./lib.mjs";

export const pinnedPnpm = "pnpm@11.25.0";
const pinnedPnpmVersion = pinnedPnpm.slice("pnpm@".length);

function samePath(left, right) {
  const normalize = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(resolve(left)) === normalize(resolve(right));
}

export function isPathInside(
  root,
  candidate,
  pathApi = { isAbsolute, relative, sep },
) {
  const path = pathApi.relative(root, candidate);
  return (
    path === "" ||
    (!pathApi.isAbsolute(path) &&
      !path.startsWith(`..${pathApi.sep}`) &&
      path !== "..")
  );
}

async function canonicalDirectory(path, label, relativeTo) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new Error(`${label} must be a valid path`);
  }
  const resolved = isAbsolute(path)
    ? resolve(path)
    : relativeTo
      ? resolve(relativeTo, path)
      : undefined;
  if (!resolved) throw new Error(`${label} must be an absolute path`);
  const canonical = await realpath(resolved).catch(() => undefined);
  if (!canonical || !(await stat(canonical)).isDirectory()) {
    throw new Error(`${label} must identify an existing directory`);
  }
  return canonical;
}

function parseModulesState(bytes, path) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid pnpm modules state at ${path}`, { cause: error });
  }
}

export async function inspectPnpmModulesState(
  nodeModulesDirectory,
  { devDependencies, expectedStoreDir } = {},
) {
  const nodeModules = await canonicalDirectory(
    resolve(nodeModulesDirectory),
    "pnpm node_modules",
  );
  const statePath = join(nodeModules, ".modules.yaml");
  const stateMetadata = await lstat(statePath).catch(() => undefined);
  if (!stateMetadata?.isFile() || stateMetadata.isSymbolicLink()) {
    throw new Error("pnpm modules state must be a regular file");
  }
  const state = parseModulesState(await readFile(statePath), statePath);
  if (state.packageManager !== pinnedPnpm) {
    throw new Error(`pnpm modules state must use ${pinnedPnpm}`);
  }
  if (state.layoutVersion !== 5 || state.nodeLinker !== "isolated") {
    throw new Error("pnpm modules state must use isolated layout version 5");
  }
  if (
    !Number.isSafeInteger(state.virtualStoreDirMaxLength) ||
    state.virtualStoreDirMaxLength <= 0
  ) {
    throw new Error("pnpm virtual store maximum path length is invalid");
  }
  if (
    !state.injectedDeps ||
    typeof state.injectedDeps !== "object" ||
    Array.isArray(state.injectedDeps)
  ) {
    throw new Error("pnpm injected dependency state is invalid");
  }
  if (
    state.included?.dependencies !== true ||
    state.included?.optionalDependencies !== true
  ) {
    throw new Error(
      "pnpm install must include production and optional dependencies",
    );
  }
  if (
    devDependencies !== undefined &&
    state.included?.devDependencies !== devDependencies
  ) {
    throw new Error(
      `pnpm devDependencies inclusion must be ${String(devDependencies)}`,
    );
  }
  if (!Array.isArray(state.pendingBuilds) || state.pendingBuilds.length !== 0) {
    throw new Error("pnpm install has pending dependency build scripts");
  }
  if (
    state.ignoredBuilds !== undefined &&
    (!Array.isArray(state.ignoredBuilds) || state.ignoredBuilds.length !== 0)
  ) {
    throw new Error("pnpm install has ignored dependency build scripts");
  }

  const expectedVirtualStore = await canonicalDirectory(
    join(nodeModules, ".pnpm"),
    "pnpm virtual store",
  );
  const configuredVirtualStore = await canonicalDirectory(
    state.virtualStoreDir,
    "configured pnpm virtual store",
    nodeModules,
  );
  if (
    !samePath(expectedVirtualStore, configuredVirtualStore) ||
    !isPathInside(nodeModules, configuredVirtualStore)
  ) {
    throw new Error("pnpm virtual store does not belong to this node_modules");
  }

  const storeDir = await canonicalDirectory(
    state.storeDir,
    "pnpm content store",
    nodeModules,
  );
  if (
    expectedStoreDir &&
    !samePath(
      storeDir,
      await canonicalDirectory(expectedStoreDir, "expected pnpm content store"),
    )
  ) {
    throw new Error("pnpm deployment used an unexpected content store");
  }
  if (isPathInside(nodeModules, storeDir)) {
    throw new Error("pnpm content store must be separate from node_modules");
  }
  return {
    nodeModules,
    state,
    storeDir,
    virtualStoreDir: expectedVirtualStore,
  };
}

export async function inspectFrozenPnpmWorkspace(workspaceDirectory) {
  const workspace = await canonicalDirectory(
    resolve(workspaceDirectory),
    "pnpm workspace",
  );
  const manifest = await readJson(join(workspace, "package.json"));
  if (manifest.packageManager !== pinnedPnpm) {
    throw new Error(`Root packageManager must be ${pinnedPnpm}`);
  }
  const [committedLock, installedLock] = await Promise.all([
    readFile(join(workspace, "pnpm-lock.yaml")),
    readFile(join(workspace, "node_modules", ".pnpm", "lock.yaml")),
  ]);
  if (!committedLock.equals(installedLock)) {
    throw new Error(
      "Installed pnpm lock does not match pnpm-lock.yaml byte for byte",
    );
  }
  const modules = await inspectPnpmModulesState(
    join(workspace, "node_modules"),
    {
      devDependencies: true,
    },
  );
  const pnpmLink = join(modules.virtualStoreDir, "node_modules", "pnpm");
  const pnpmPackage = await realpath(pnpmLink).catch(() => undefined);
  if (!pnpmPackage || !isPathInside(modules.virtualStoreDir, pnpmPackage)) {
    throw new Error("Installed pinned pnpm package escapes the virtual store");
  }
  const pnpmManifest = await readJson(join(pnpmPackage, "package.json"));
  if (
    pnpmManifest.name !== "pnpm" ||
    pnpmManifest.version !== pinnedPnpmVersion
  ) {
    throw new Error(`Installed pnpm package must be ${pinnedPnpm}`);
  }
  const pnpmBin = await realpath(join(pnpmPackage, "bin", "pnpm.cjs")).catch(
    () => undefined,
  );
  if (
    !pnpmBin ||
    !isPathInside(pnpmPackage, pnpmBin) ||
    !(await stat(pnpmBin)).isFile()
  ) {
    throw new Error("Installed pinned pnpm executable is unsafe or missing");
  }
  return { ...modules, pnpmBin, workspace };
}

export function sharedDeployArguments(
  destinationDirectory,
  storeDir,
  cacheDirectory,
) {
  const cacheArguments = cacheDirectory
    ? [`--config.cache-dir=${resolve(cacheDirectory)}`]
    : [];
  return [
    "--config.inject-workspace-packages=true",
    "--store-dir",
    storeDir,
    ...cacheArguments,
    "--filter",
    "@one-fetch/adapter-node",
    "deploy",
    "--prod",
    "--offline",
    "--frozen-lockfile",
    "--frozen-store",
    "--ignore-scripts",
    "--trust-lockfile",
    resolve(destinationDirectory),
  ];
}

export async function runSharedPnpmDeploy({
  cacheDirectory,
  destinationDirectory,
  environment = process.env,
  workspaceDirectory,
}) {
  const workspace = await inspectFrozenPnpmWorkspace(workspaceDirectory);
  const actualVersion = run(
    process.execPath,
    [workspace.pnpmBin, "--version"],
    {
      capture: true,
      cwd: workspace.workspace,
      env: environment,
    },
  );
  if (actualVersion !== pinnedPnpmVersion) {
    throw new Error(
      `Pinned pnpm command must be ${pinnedPnpmVersion}, received ${actualVersion}`,
    );
  }
  run(
    process.execPath,
    [
      workspace.pnpmBin,
      ...sharedDeployArguments(
        destinationDirectory,
        workspace.storeDir,
        cacheDirectory,
      ),
    ],
    {
      cwd: workspace.workspace,
      env: { ...environment, CI: "true" },
    },
  );
  return workspace;
}
