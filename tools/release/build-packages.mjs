import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  archiveFilename,
  copyDirectory,
  corepackPnpm,
  makeTemporaryDirectory,
  readJson,
  releaseAssetUrl,
  repositoryRoot,
  requireVersion,
} from "./lib.mjs";

const repository = "OKFred/one-fetch";

function releaseDependencies(dependencies, version) {
  return Object.fromEntries(
    Object.entries(dependencies ?? {}).map(([name, value]) => {
      if (!name.startsWith("@one-fetch/") || !value.startsWith("workspace:"))
        return [name, value];
      const filename = archiveFilename(name, version);
      return [name, releaseAssetUrl(repository, version, filename)];
    }),
  );
}

async function stagePackage(packageDirectory, stagingDirectory, version) {
  const source = await readJson(join(packageDirectory, "package.json"));
  if (source.version !== version)
    throw new Error(`${source.name} version does not match ${version}`);
  if (!(await readdir(join(packageDirectory, "dist")).catch(() => undefined))) {
    throw new Error(
      `${source.name} has no dist directory; build before packaging`,
    );
  }

  const manifest = {
    name: source.name,
    version,
    description: `Immutable GitHub Release artifact for ${source.name}`,
    type: source.type,
    license: "MIT",
    exports: source.exports,
    bin: source.bin,
    files: ["dist", "README.md", "LICENSE"],
    dependencies: releaseDependencies(source.dependencies, version),
    repository: {
      type: "git",
      url: "git+https://github.com/OKFred/one-fetch.git",
    },
  };
  for (const key of Object.keys(manifest)) {
    if (manifest[key] === undefined) delete manifest[key];
  }

  await mkdir(stagingDirectory, { recursive: true });
  await copyDirectory(
    join(packageDirectory, "dist"),
    join(stagingDirectory, "dist"),
  );
  await rm(join(stagingDirectory, "dist", ".tsbuildinfo"), { force: true });
  await copyFile(
    join(repositoryRoot, "LICENSE"),
    join(stagingDirectory, "LICENSE"),
  );
  await writeFile(
    join(stagingDirectory, "README.md"),
    `# ${source.name}\n\nThis package is distributed only as an immutable one-fetch GitHub Release artifact.\n`,
    "utf8",
  );
  await writeFile(
    join(stagingDirectory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return source.name;
}

async function copyDeclarations(source, destination, prefix) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (
        entry.name.endsWith(".d.ts") ||
        entry.name.endsWith(".d.ts.map")
      ) {
        const target = join(destination, prefix, relative(source, path));
        await mkdir(dirname(target), { recursive: true });
        await copyFile(path, target);
      }
    }
  }
  await visit(source);
}

async function stageTypes(stagingDirectory, version) {
  await mkdir(join(stagingDirectory, "dist"), { recursive: true });
  for (const packageName of ["protocol", "core", "client"]) {
    await copyDeclarations(
      join(repositoryRoot, "packages", packageName, "dist"),
      join(stagingDirectory, "dist"),
      packageName,
    );
  }
  const manifest = {
    name: "@one-fetch/types",
    version,
    description: "TypeScript declarations for one-fetch Release artifacts",
    license: "MIT",
    files: ["dist", "README.md", "LICENSE"],
    repository: {
      type: "git",
      url: "git+https://github.com/OKFred/one-fetch.git",
    },
  };
  await copyFile(
    join(repositoryRoot, "LICENSE"),
    join(stagingDirectory, "LICENSE"),
  );
  await writeFile(
    join(stagingDirectory, "README.md"),
    "# one-fetch TypeScript declarations\n",
    "utf8",
  );
  await writeFile(
    join(stagingDirectory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest.name;
}

async function pack(stagingDirectory, outputDirectory, name, version) {
  corepackPnpm(["pack", "--pack-destination", outputDirectory], {
    cwd: stagingDirectory,
  });
  const expected = archiveFilename(name, version);
  const actual = (await readdir(outputDirectory)).find(
    (filename) => filename.toLowerCase() === expected.toLowerCase(),
  );
  if (!actual) throw new Error(`pnpm pack did not create ${expected}`);
  if (actual !== expected) {
    await copyFile(
      join(outputDirectory, actual),
      join(outputDirectory, expected),
    );
    await rm(join(outputDirectory, actual));
  }
  return expected;
}

export async function buildReleasePackages(outputDirectory, version) {
  const checkedVersion = requireVersion(version);
  const temporaryRoot = await makeTemporaryDirectory("one-fetch-release-");
  const files = [];
  try {
    for (const packageName of ["protocol", "core", "client"]) {
      const stage = join(temporaryRoot, packageName);
      const name = await stagePackage(
        join(repositoryRoot, "packages", packageName),
        stage,
        checkedVersion,
      );
      files.push(await pack(stage, outputDirectory, name, checkedVersion));
    }
    const typeStage = join(temporaryRoot, "types");
    const typeName = await stageTypes(typeStage, checkedVersion);
    files.push(
      await pack(typeStage, outputDirectory, typeName, checkedVersion),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return files;
}
