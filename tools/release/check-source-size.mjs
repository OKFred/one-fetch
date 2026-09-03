import console from "node:console";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { repositoryRoot } from "./lib.mjs";

const roots = ["apps", "adapters", "packages", "tools"];
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".vue",
  ".sh",
  ".ps1",
  ".sql",
]);
const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  "coverage",
  "generated",
  ".wrangler",
]);
const hardLimit = 1_000;
const preferredLimit = 500;
const overPreferred = [];
const overHardLimit = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (
      entry.isFile() &&
      sourceExtensions.has(extname(entry.name)) &&
      !entry.name.endsWith(".d.ts")
    ) {
      const lines = (await readFile(path, "utf8")).split(/\r?\n/u).length;
      const item = `${relative(repositoryRoot, path)}: ${lines} lines`;
      if (lines > hardLimit) overHardLimit.push(item);
      else if (lines > preferredLimit) overPreferred.push(item);
    }
  }
}

for (const root of roots) await visit(join(repositoryRoot, root));

if (overPreferred.length > 0) {
  console.warn(
    `Files above the preferred 500-line size:\n${overPreferred.join("\n")}`,
  );
}
if (overHardLimit.length > 0) {
  throw new Error(
    `Files above the 1,000-line hard limit:\n${overHardLimit.join("\n")}`,
  );
}
console.log("No authored source file exceeds 1,000 lines");
