import console from "node:console";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { format } from "prettier";

import { corepackPnpm, join, readJson, repositoryRoot } from "./lib.mjs";

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

function normalizeSchemaPatterns(value) {
  if (Array.isArray(value)) {
    for (const item of value) normalizeSchemaPatterns(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "pattern" &&
      typeof child === "string" &&
      child.endsWith("/u")
    ) {
      value[key] = child.slice(0, -2);
    } else normalizeSchemaPatterns(child);
  }
}

const document = await response.json();
normalizeSchemaPatterns(document);
document.info.version = rootManifest.version;
document.info.description =
  "Canonical one-fetch Control API. Runtime capabilities remain authoritative.";
document.servers = [
  { url: ".", description: "The configured Control service base URL" },
];
document.tags = [
  { name: "public" },
  { name: "auth" },
  { name: "configuration" },
  { name: "operations" },
];

const outputPath = join(repositoryRoot, "docs", "api", "control.openapi.json");
const generated = await format(JSON.stringify(document), {
  filepath: outputPath,
});
if (argumentsSet.has("--check")) {
  const committed = await readFile(outputPath, "utf8");
  if (committed !== generated) {
    throw new Error(
      "Control OpenAPI is stale; run pnpm generate:openapi and commit the result",
    );
  }
  console.log("Control OpenAPI is current");
} else {
  await writeFile(outputPath, generated, "utf8");
  console.log(`Generated ${outputPath}`);
}
