import console from "node:console";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  corepackPnpm,
  join,
  readJson,
  repositoryRoot,
  writeJson,
} from "./lib.mjs";

const argumentsSet = new Set(process.argv.slice(2));
if ([...argumentsSet].some((argument) => argument !== "--check")) {
  throw new Error("Usage: generate-openapi.mjs [--check]");
}

const rootManifest = await readJson(join(repositoryRoot, "package.json"));
corepackPnpm(["--filter", "@one-fetch/adapter-node...", "build"]);

const { createControlApp } = await import(
  pathToFileURL(join(repositoryRoot, "adapters", "node", "dist", "control.js"))
);
const app = createControlApp({ config: { controlAllowedOrigins: [] } });
const response = await app.request(
  "https://control.example/api/v1/openapi.json",
);
if (!response.ok) {
  throw new Error(`OpenAPI generation failed with HTTP ${response.status}`);
}

const document = await response.json();
document.info.version = rootManifest.version;
document.info.description =
  "Canonical one-fetch Control API. Runtime capabilities remain authoritative.";
document.servers = [{ url: "https://control.example" }];
document.tags = [
  { name: "public" },
  { name: "auth" },
  { name: "configuration" },
  { name: "operations" },
];

const outputPath = join(repositoryRoot, "docs", "api", "control.openapi.json");
const generated = `${JSON.stringify(document, null, 2)}\n`;
if (argumentsSet.has("--check")) {
  const committed = await readFile(outputPath, "utf8");
  if (committed !== generated) {
    throw new Error(
      "Control OpenAPI is stale; run pnpm generate:openapi and commit the result",
    );
  }
  console.log("Control OpenAPI is current");
} else {
  await writeJson(outputPath, document);
  console.log(`Generated ${outputPath}`);
}
