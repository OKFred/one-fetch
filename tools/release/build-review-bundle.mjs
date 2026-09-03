import console from "node:console";
import { copyFile } from "node:fs/promises";
import process from "node:process";

import { buildReleasePackages } from "./build-packages.mjs";
import { generateProtocolSchemas } from "./generate-schemas.mjs";
import {
  defaultOutputRoot,
  join,
  parseArguments,
  readJson,
  releaseDirectory,
  repositoryRoot,
  resetDirectory,
} from "./lib.mjs";

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

await resetDirectory(outputDirectory);
const packageFiles = await buildReleasePackages(outputDirectory, version);
const schemaFile = await generateProtocolSchemas(outputDirectory, version);

const openApi = await readJson(
  join(repositoryRoot, "docs", "api", "control.openapi.json"),
);
openApi.info.version = version;
const openApiFilename = `one-fetch-control-openapi-${version}.json`;
await copyFile(
  join(repositoryRoot, "docs", "api", "control.openapi.json"),
  join(outputDirectory, openApiFilename),
);
if (
  openApi.info.version !==
  (await readJson(join(outputDirectory, openApiFilename))).info.version
) {
  const { writeJson } = await import("./lib.mjs");
  await writeJson(join(outputDirectory, openApiFilename), openApi);
}

console.log(
  `Built ${packageFiles.length + 2} review artifacts in ${outputDirectory}`,
);
console.log([...packageFiles, schemaFile, openApiFilename].join("\n"));
