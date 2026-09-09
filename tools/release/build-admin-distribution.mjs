import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { writeDeterministicZip } from "./deterministic-zip.mjs";
import {
  readJson,
  relativePosix,
  repositoryRoot,
  requireVersion,
} from "./lib.mjs";

const adminRoot = join(repositoryRoot, "apps", "admin");

async function collectFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Admin distribution cannot contain a symbolic link: ${path}`,
      );
    }
    if (entry.isDirectory()) files.push(...(await collectFiles(root, path)));
    else if (entry.isFile()) {
      files.push({
        data: await readFile(path),
        name: relativePosix(root, path),
      });
    } else throw new Error(`Unsupported Admin distribution entry: ${path}`);
  }
  return files;
}

export async function buildAdminDistribution(outputDirectory, version) {
  const checkedVersion = requireVersion(version);
  const manifest = await readJson(join(adminRoot, "package.json"));
  if (manifest.version !== checkedVersion) {
    throw new Error(`Admin version does not match ${checkedVersion}`);
  }
  const distributionRoot = join(adminRoot, "dist");
  if (
    !(
      await stat(join(distributionRoot, "index.html")).catch(() => undefined)
    )?.isFile()
  ) {
    throw new Error("Admin dist/index.html is missing; build before packaging");
  }
  const entries = await collectFiles(distributionRoot);
  const filename = `one-fetch-admin-${checkedVersion}.zip`;
  await writeDeterministicZip(join(outputDirectory, filename), entries);
  return [filename];
}
