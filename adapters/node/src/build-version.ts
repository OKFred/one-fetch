import { readFileSync } from "node:fs";

// src/ and dist/ both live directly beneath the adapter's package.json.
// Resolve from this module, never cwd or a deployment-controlled environment
// override. Portable archives retain that same layout and package identity.
export function readBuildVersion(manifestUrl: URL): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestUrl, "utf8"));
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("name" in manifest) ||
      manifest.name !== "@one-fetch/adapter-node" ||
      !("version" in manifest) ||
      typeof manifest.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)
    ) {
      throw new Error("Invalid package identity");
    }
    return manifest.version;
  } catch {
    // Fail before starting listeners. Never invent a version or include the
    // contents of an invalid local file in diagnostics.
    throw new Error("Node runtime package identity is missing or invalid");
  }
}

export const BUILD_VERSION = readBuildVersion(
  new URL("../package.json", import.meta.url),
);
