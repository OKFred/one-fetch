import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { BUILD_VERSION, readBuildVersion } from "./build-version.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function fixture(contents?: string): Promise<URL> {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-version-"));
  directories.push(directory);
  const path = join(directory, "package.json");
  if (contents !== undefined) await writeFile(path, contents);
  return pathToFileURL(path);
}

describe("Node runtime build identity", () => {
  it.each(["0.1.0", "0.1.1", "0.2.0-preview.1"])(
    "reads %s from package identity rather than a fallback",
    async (version) => {
      const url = await fixture(
        JSON.stringify({ name: "@one-fetch/adapter-node", version }),
      );
      expect(readBuildVersion(url)).toBe(version);
    },
  );

  it("matches the installed adapter manifest", () => {
    expect(BUILD_VERSION).toBe(
      readBuildVersion(new URL("../package.json", import.meta.url)),
    );
  });

  it.each([
    undefined,
    "not-json-secret-canary",
    "null",
    "[]",
    '{"version":"0.1.1"}',
    '{"name":"unrelated","version":"0.1.1"}',
    '{"name":"@one-fetch/adapter-node","version":1}',
    '{"name":"@one-fetch/adapter-node","version":"latest"}',
    '{"name":"@one-fetch/adapter-node","version":"0.1.1\\nsecret"}',
  ])("rejects missing or malformed identity (%s)", async (contents) => {
    const url = await fixture(contents);
    expect(() => readBuildVersion(url)).toThrowError(
      "Node runtime package identity is missing or invalid",
    );
  });
});
