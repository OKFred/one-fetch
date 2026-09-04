import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInside(root, candidate) {
  const value = relative(root, candidate);
  return (
    value === "" ||
    (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
  );
}

async function packageEntries(aggregateDirectory) {
  const entries = [];
  const topLevel = await readdir(aggregateDirectory, { withFileTypes: true });
  topLevel.sort((left, right) => ordinal(left.name, right.name));
  for (const entry of topLevel) {
    if (!entry.name.startsWith("@")) {
      entries.push({
        name: entry.name,
        source: join(aggregateDirectory, entry.name),
      });
      continue;
    }
    if (!entry.isDirectory()) {
      throw new Error(`Invalid pnpm scope entry: ${entry.name}`);
    }
    const scopeDirectory = join(aggregateDirectory, entry.name);
    const scoped = await readdir(scopeDirectory, { withFileTypes: true });
    scoped.sort((left, right) => ordinal(left.name, right.name));
    for (const child of scoped) {
      entries.push({
        name: `${entry.name}/${child.name}`,
        source: join(scopeDirectory, child.name),
      });
    }
  }
  return entries;
}

async function copyContainedTree(source, destination, sourceRoot, ancestors) {
  const canonicalSource = await realpath(source);
  if (!isInside(sourceRoot, canonicalSource)) {
    throw new Error(`Production dependency escapes node_modules: ${source}`);
  }
  const metadata = await stat(canonicalSource);
  if (metadata.isFile()) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(canonicalSource, destination);
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Unsupported production dependency entry: ${source}`);
  }
  if (ancestors.has(canonicalSource)) {
    throw new Error(`Cyclic production dependency link: ${source}`);
  }
  const nextAncestors = new Set(ancestors).add(canonicalSource);
  await mkdir(destination, { recursive: true });
  const children = await readdir(canonicalSource, { withFileTypes: true });
  children.sort((left, right) => ordinal(left.name, right.name));
  for (const child of children) {
    await copyContainedTree(
      join(canonicalSource, child.name),
      join(destination, child.name),
      sourceRoot,
      nextAncestors,
    );
  }
}

async function assertNoLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`Portable node_modules still contains a link: ${path}`);
    }
    if (entry.isDirectory()) await assertNoLinks(path);
  }
}

export async function materializePortableNodeModules(nodeModulesDirectory) {
  const sourceDirectory = resolve(nodeModulesDirectory);
  const sourceRoot = await realpath(sourceDirectory);
  const aggregateDirectory = join(sourceRoot, ".pnpm", "node_modules");
  const packages = await packageEntries(aggregateDirectory);
  if (packages.length === 0) {
    throw new Error("pnpm production deployment contains no packages");
  }

  const portableDirectory = `${sourceDirectory}.portable`;
  if (await lstat(portableDirectory).catch(() => undefined)) {
    throw new Error(
      `Portable node_modules path already exists: ${portableDirectory}`,
    );
  }
  await mkdir(portableDirectory);
  try {
    for (const dependency of packages) {
      await copyContainedTree(
        dependency.source,
        join(portableDirectory, ...dependency.name.split("/")),
        sourceRoot,
        new Set(),
      );
    }
    await assertNoLinks(portableDirectory);
    await rm(sourceDirectory, { recursive: true, force: true });
    await rename(portableDirectory, sourceDirectory);
  } catch (error) {
    await rm(portableDirectory, { recursive: true, force: true });
    throw error;
  }
  return packages.map(({ name }) => name);
}
