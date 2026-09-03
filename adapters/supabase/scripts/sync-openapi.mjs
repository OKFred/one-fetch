import console from "node:console";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

const argumentsSet = new Set(process.argv.slice(2));
if ([...argumentsSet].some((argument) => argument !== "--check")) {
  throw new Error("Usage: sync-openapi.mjs [--check]");
}

const sourceUrl = new URL(
  "../../../docs/api/control.openapi.json",
  import.meta.url,
);
const destinationUrl = new URL(
  "../supabase/functions/_shared/control-openapi.generated.ts",
  import.meta.url,
);

const source = await readFile(sourceUrl, "utf8");
const document = JSON.parse(source);
if (
  document.openapi !== "3.1.0" ||
  typeof document.paths !== "object" ||
  document.paths?.["/api/v1/health"] === undefined ||
  document.paths?.["/api/v1/capabilities"] === undefined ||
  document.paths?.["/api/v1/openapi.json"] === undefined
) {
  throw new Error("Canonical Control OpenAPI document failed validation");
}
const jsonLiteral = `'${JSON.stringify(document)
  .replaceAll("\\", "\\\\")
  .replaceAll("'", "\\'")
  .replaceAll("\u2028", "\\u2028")
  .replaceAll("\u2029", "\\u2029")}'`;
const moduleSource = `// Generated from docs/api/control.openapi.json. Do not edit.\nexport const CONTROL_OPENAPI_JSON =\n  ${jsonLiteral};\n`;
if (argumentsSet.has("--check")) {
  const embedded = await readFile(destinationUrl, "utf8");
  if (embedded !== moduleSource) {
    throw new Error(
      "Supabase embedded OpenAPI is stale; run pnpm --filter @one-fetch/adapter-supabase sync:openapi",
    );
  }
  console.log("Supabase embedded OpenAPI is current");
} else {
  await writeFile(destinationUrl, moduleSource, { encoding: "utf8" });
}
