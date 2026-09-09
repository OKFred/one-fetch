import console from "node:console";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readJson, repositoryRoot } from "./lib.mjs";

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const internalWorkspace = /^workspace:\*$/u;
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const manifests = [join(repositoryRoot, "package.json")];

for (const parent of ["packages", "adapters", "apps"]) {
  for (const entry of await readdir(join(repositoryRoot, parent), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory())
      manifests.push(join(repositoryRoot, parent, entry.name, "package.json"));
  }
}

const violations = [];
for (const manifestPath of manifests) {
  const manifest = await readJson(manifestPath);
  for (const field of dependencyFields) {
    for (const [name, value] of Object.entries(manifest[field] ?? {})) {
      const allowed =
        exactVersion.test(value) ||
        (name.startsWith("@one-fetch/") && internalWorkspace.test(value));
      if (!allowed)
        violations.push(`${manifest.name} ${field}.${name}=${value}`);
    }
  }
  for (const lifecycle of [
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "publish",
    "postpublish",
  ]) {
    if (manifest.scripts?.[lifecycle])
      violations.push(`${manifest.name} defines lifecycle script ${lifecycle}`);
  }
}

if (violations.length > 0) {
  throw new Error(`Dependency policy failed:\n${violations.join("\n")}`);
}
console.log(`Dependency policy verified across ${manifests.length} manifests`);
