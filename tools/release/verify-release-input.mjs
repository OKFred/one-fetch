import console from "node:console";
import process from "node:process";

import {
  join,
  parseArguments,
  readJson,
  repositoryRoot,
  requireVersion,
} from "./lib.mjs";

const argumentsMap = parseArguments(process.argv.slice(2));
const rootManifest = await readJson(join(repositoryRoot, "package.json"));
const requestedVersion = requireVersion(
  argumentsMap.get("version") === true ||
    argumentsMap.get("version") === undefined
    ? rootManifest.version
    : argumentsMap.get("version"),
);
const channel = argumentsMap.get("channel") ?? "preview";

if (!new Set(["preview", "stable"]).has(channel)) {
  throw new Error(`Channel must be preview or stable, received ${channel}`);
}
if (rootManifest.version !== requestedVersion) {
  throw new Error(
    `Root version ${rootManifest.version} does not match ${requestedVersion}`,
  );
}
if (
  channel === "stable" &&
  requestedVersion !== "1.0.0" &&
  requestedVersion.startsWith("0.")
) {
  throw new Error("Stable releases cannot use a 0.x Preview version");
}

const packagePaths = [
  "packages/protocol/package.json",
  "packages/core/package.json",
  "packages/client/package.json",
  "packages/conformance/package.json",
  "adapters/cloudflare/package.json",
  "adapters/supabase/package.json",
  "adapters/node/package.json",
  "apps/admin/package.json",
];

for (const packagePath of packagePaths) {
  const manifest = await readJson(join(repositoryRoot, packagePath));
  if (manifest.version !== requestedVersion) {
    throw new Error(
      `${packagePath} has version ${manifest.version}, expected ${requestedVersion}`,
    );
  }
  if (manifest.private !== true) {
    throw new Error(
      `${packagePath} must stay private; GitHub artifacts replace npm publishing`,
    );
  }
}

const openApi = await readJson(
  join(repositoryRoot, "docs/api/control.openapi.json"),
);

function assertPortablePatterns(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertPortablePatterns(item, `${path}[${index}]`),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "pattern" &&
      typeof child === "string" &&
      /\/[dgimsuvy]+$/u.test(child)
    ) {
      throw new Error(`${path}.${key} contains JavaScript-only regex flags`);
    }
    assertPortablePatterns(child, `${path}.${key}`);
  }
}

if (openApi.openapi !== "3.1.0")
  throw new Error("Control document must use OpenAPI 3.1.0");
if (openApi.info?.version !== requestedVersion) {
  throw new Error(
    `Control OpenAPI version ${openApi.info?.version} does not match ${requestedVersion}`,
  );
}
assertPortablePatterns(openApi);

const requiredPaths = [
  "/api/v1/health",
  "/api/v1/capabilities",
  "/api/v1/bootstrap",
  "/api/v1/auth/login",
  "/api/v1/auth/refresh",
  "/api/v1/config",
  "/api/v1/config/policy",
  "/api/v1/tokens/execution",
  "/api/v1/audit",
  "/api/v1/alerts",
  "/api/v1/backups",
  "/api/v1/reports/{reportId}",
];
for (const path of requiredPaths) {
  if (!openApi.paths?.[path])
    throw new Error(`Control OpenAPI is missing ${path}`);
}

console.log(`Release input verified: ${requestedVersion} (${channel})`);
