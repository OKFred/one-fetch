import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  inspectPnpmModulesState,
  isPathInside,
} from "./pnpm-shared-deploy.mjs";

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedPath(path) {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function parseManifest(bytes, path) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid package manifest ${path}`, { cause: error });
  }
}

async function packageEntries(directory) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => ordinal(left.name, right.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (!entry.name.startsWith("@")) {
      result.push({ logicalName: entry.name, path });
      continue;
    }
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Invalid package scope container: ${path}`);
    }
    const children = await readdir(path, { withFileTypes: true });
    children.sort((left, right) => ordinal(left.name, right.name));
    for (const child of children) {
      if (child.name.startsWith(".")) {
        throw new Error(`Invalid scoped package entry: ${child.name}`);
      }
      result.push({
        logicalName: `${entry.name}/${child.name}`,
        path: join(path, child.name),
      });
    }
  }
  return result;
}

function snapshotContext(virtualStore, canonicalTarget) {
  if (!isPathInside(virtualStore, canonicalTarget)) {
    return `direct:${relative(resolve(virtualStore, ".."), canonicalTarget)}`;
  }
  return relative(virtualStore, canonicalTarget).split(sep)[0];
}

async function inspectEntry(entry, nodeModules, virtualStore) {
  const canonicalTarget = await realpath(entry.path).catch(() => undefined);
  if (!canonicalTarget || !isPathInside(nodeModules, canonicalTarget)) {
    throw new Error(
      `Package ${entry.logicalName} resolves outside deployment node_modules`,
    );
  }
  if (!(await stat(canonicalTarget)).isDirectory()) {
    throw new Error(`Package ${entry.logicalName} is not a directory`);
  }
  const manifestPath = join(canonicalTarget, "package.json");
  const canonicalManifest = await realpath(manifestPath).catch(() => undefined);
  if (!canonicalManifest || !isPathInside(canonicalTarget, canonicalManifest)) {
    throw new Error(
      `Package ${entry.logicalName} has no contained package.json`,
    );
  }
  const manifest = parseManifest(
    await readFile(canonicalManifest),
    manifestPath,
  );
  if (manifest.name !== entry.logicalName) {
    throw new Error(
      `Logical package ${entry.logicalName} resolves to ${String(manifest.name)}`,
    );
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`Package ${entry.logicalName} has no version`);
  }
  return {
    name: entry.logicalName,
    version: manifest.version,
    peerContext: snapshotContext(virtualStore, canonicalTarget),
    canonicalTarget,
    manifest,
  };
}

async function collectPackages(nodeModules, virtualStore) {
  const aggregate = join(virtualStore, "node_modules");
  const sources = [
    ...(await packageEntries(nodeModules)),
    ...(await packageEntries(aggregate)),
  ];
  const packages = new Map();
  for (const source of sources) {
    const candidate = await inspectEntry(source, nodeModules, virtualStore);
    const current = packages.get(candidate.name);
    if (!current) {
      packages.set(candidate.name, candidate);
      continue;
    }
    if (
      !samePath(current.canonicalTarget, candidate.canonicalTarget) ||
      current.version !== candidate.version ||
      current.peerContext !== candidate.peerContext
    ) {
      throw new Error(
        `Conflicting package ${candidate.name}: canonical target, version, or peer context differs`,
      );
    }
  }
  if (packages.size === 0) {
    throw new Error("pnpm shared deployment contains no production packages");
  }
  const result = [...packages.values()].sort((left, right) =>
    ordinal(left.name, right.name),
  );
  await validatePackageMap(nodeModules, result);
  return result;
}

async function validatePackageMap(nodeModules, packages) {
  const mapPath = join(nodeModules, ".package-map.json");
  const metadata = await lstat(mapPath).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error("pnpm shared deployment has no regular package map");
  }
  let packageMap;
  try {
    packageMap = JSON.parse(await readFile(mapPath, "utf8"));
  } catch (error) {
    throw new Error("pnpm shared deployment has an invalid package map", {
      cause: error,
    });
  }
  if (!packageMap?.packages || typeof packageMap.packages !== "object") {
    throw new Error("pnpm shared deployment package map has no packages");
  }
  const byName = new Map(packages.map((item) => [item.name, item]));
  const covered = new Set();
  for (const [context, record] of Object.entries(packageMap.packages)) {
    if (context === ".") continue;
    if (
      typeof record?.url !== "string" ||
      resolve(nodeModules, record.url) === resolve(nodeModules) ||
      !isPathInside(nodeModules, resolve(nodeModules, record.url))
    ) {
      throw new Error(`pnpm package map context ${context} has an unsafe URL`);
    }
    const canonical = await realpath(resolve(nodeModules, record.url)).catch(
      () => undefined,
    );
    if (!canonical || !isPathInside(nodeModules, canonical)) {
      throw new Error(
        `pnpm package map context ${context} escapes node_modules`,
      );
    }
    const manifestPath = join(canonical, "package.json");
    const manifest = parseManifest(await readFile(manifestPath), manifestPath);
    const selected = byName.get(manifest.name);
    if (
      !selected ||
      !samePath(selected.canonicalTarget, canonical) ||
      selected.version !== manifest.version
    ) {
      throw new Error(
        `Package ${String(manifest.name)} has an unmergeable peer context ${context}`,
      );
    }
    if (selected.packageMapContext && selected.packageMapContext !== context) {
      throw new Error(
        `Package ${selected.name} has conflicting peer contexts ${selected.packageMapContext} and ${context}`,
      );
    }
    selected.packageMapContext = context;
    selected.peerContext = context;
    covered.add(selected.name);
  }
  for (const item of packages) {
    if (!covered.has(item.name)) {
      throw new Error(
        `Package ${item.name} is absent from the pnpm package map`,
      );
    }
  }
}

function assertPortableManifest(manifest, name, allowBundled = false) {
  for (const field of ["os", "cpu", "libc"]) {
    if (Object.hasOwn(manifest, field)) {
      throw new Error(`Package ${name} has non-portable ${field} restrictions`);
    }
  }
  const bundled = manifest.bundledDependencies ?? manifest.bundleDependencies;
  if (!allowBundled && Array.isArray(bundled) && bundled.length > 0) {
    throw new Error(`Package ${name} has bundled dependencies`);
  }
}

async function copyContainedTree(source, destination, packageRoot, ancestors) {
  const canonical = await realpath(source);
  if (!isPathInside(packageRoot, canonical)) {
    throw new Error(`Package content escapes its canonical root: ${source}`);
  }
  const metadata = await stat(canonical);
  if (metadata.isFile()) {
    if (
      source.toLowerCase().endsWith(".node") ||
      canonical.toLowerCase().endsWith(".node")
    ) {
      throw new Error(`Native .node binary is not portable: ${source}`);
    }
    await mkdir(resolve(destination, ".."), { recursive: true });
    await copyFile(canonical, destination);
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Unsupported package content: ${source}`);
  }
  if (ancestors.has(canonical)) {
    throw new Error(`Cyclic package content link: ${source}`);
  }
  const nextAncestors = new Set(ancestors).add(canonical);
  await mkdir(destination, { recursive: true });
  const entries = await readdir(canonical, { withFileTypes: true });
  entries.sort((left, right) => ordinal(left.name, right.name));
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    await copyContainedTree(
      join(canonical, entry.name),
      join(destination, entry.name),
      packageRoot,
      nextAncestors,
    );
  }
}

function forbiddenAbsolutePatterns(paths) {
  const variants = paths.flatMap((path) => {
    const canonical = resolve(path);
    const fileUrl = pathToFileURL(canonical).href;
    return [
      canonical,
      canonical.replaceAll("\\", "/"),
      fileUrl,
      JSON.stringify(canonical).slice(1, -1),
      JSON.stringify(fileUrl).slice(1, -1),
    ];
  });
  return [...new Set(variants)].map((value) =>
    process.platform === "win32" ? value.toLowerCase() : value,
  );
}

export async function assertPortableDistributionTree(
  directory,
  forbiddenPaths,
) {
  const patterns = forbiddenAbsolutePatterns(forbiddenPaths);
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Portable node_modules contains a link: ${path}`);
      }
      if (entry.name === ".pnpm") {
        throw new Error(`Portable node_modules contains pnpm state: ${path}`);
      }
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(
          `Portable node_modules contains a special file: ${path}`,
        );
      }
      if (entry.name.toLowerCase().endsWith(".node")) {
        throw new Error(
          `Portable node_modules contains a native .node binary: ${path}`,
        );
      }
      const bytes = await readFile(path);
      const text =
        process.platform === "win32"
          ? bytes.toString("utf8").toLowerCase()
          : bytes.toString("utf8");
      if (patterns.some((pattern) => text.includes(pattern))) {
        throw new Error(
          `Portable package contains an absolute workspace reference: ${path}`,
        );
      }
      if (entry.name === "package.json") {
        const manifest = parseManifest(bytes, path);
        assertPortableManifest(
          manifest,
          manifest.name ?? path,
          resolve(path) === resolve(directory, "package.json"),
        );
      }
    }
  }
  await visit(directory);
}

export async function materializePortableNodeModules(
  nodeModulesDirectory,
  { expectedStoreDir, workspaceDirectory },
) {
  const modules = await inspectPnpmModulesState(nodeModulesDirectory, {
    devDependencies: false,
    expectedStoreDir,
  });
  const packages = await collectPackages(
    modules.nodeModules,
    modules.virtualStoreDir,
  );
  const portableDirectory = `${modules.nodeModules}.portable`;
  const originalDirectory = `${modules.nodeModules}.pnpm-source`;
  if (
    (await lstat(portableDirectory).catch(() => undefined)) ||
    (await lstat(originalDirectory).catch(() => undefined))
  ) {
    throw new Error(
      "Refusing to overwrite an existing node_modules staging path",
    );
  }
  await mkdir(portableDirectory);
  try {
    for (const dependency of packages) {
      assertPortableManifest(dependency.manifest, dependency.name);
      await copyContainedTree(
        dependency.canonicalTarget,
        join(portableDirectory, ...dependency.name.split("/")),
        dependency.canonicalTarget,
        new Set(),
      );
    }
    await assertPortableDistributionTree(portableDirectory, [
      workspaceDirectory,
      expectedStoreDir,
      resolve(modules.nodeModules, ".."),
    ]);
    await rename(modules.nodeModules, originalDirectory);
    try {
      await rename(portableDirectory, modules.nodeModules);
    } catch (error) {
      await rename(originalDirectory, modules.nodeModules);
      throw error;
    }
    await rm(originalDirectory, { recursive: true, force: true });
  } catch (error) {
    await rm(portableDirectory, { recursive: true, force: true });
    throw error;
  }
  return packages.map(({ name, peerContext, version }) => ({
    name,
    peerContext,
    version,
  }));
}
