import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyDownloadedRelease } from "../release/public-release.mjs";
import { assertSafeArchiveEntries } from "../deploy/node.mjs";

export function parseRuntimeArguments(values) {
  const allowed = new Set([
    "directory",
    "commit",
    "version",
    "image",
    "platform",
    "mode",
    "output",
  ]);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]?.replace(/^--/u, "");
    const value = values[index + 1];
    if (
      !values[index]?.startsWith("--") ||
      !allowed.has(name) ||
      result[name] !== undefined ||
      !value ||
      value.startsWith("--")
    )
      throw new Error("Invalid or duplicate runtime acceptance argument");
    result[name] = value;
  }
  if ([...allowed].some((name) => !result[name]))
    throw new Error("All runtime acceptance arguments are required");
  if (
    !/^[a-f0-9]{40}$/u.test(result.commit) ||
    !/^0\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(result.version) ||
    !/^sha256:[a-f0-9]{64}$/u.test(result.image)
  )
    throw new Error(
      "Exact version, commit and local image digest are required",
    );
  if (
    !["linux/amd64", "linux/arm64"].includes(result.platform) ||
    !["oci", "archive", "installed"].includes(result.mode)
  )
    throw new Error("Unsupported runtime acceptance platform or mode");
  return result;
}

export async function verifyRuntimeInput(options) {
  const directory = resolve(options.directory);
  const entries = [];
  for (const name of await readdir(directory)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/u.test(name))
      throw new Error("Unsafe review filename");
    const path = join(directory, name);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink())
      throw new Error("Review entries must be regular files");
    const sha256 = createHash("sha256");
    const sha512 = createHash("sha512");
    for await (const bytes of createReadStream(path)) {
      sha256.update(bytes);
      sha512.update(bytes);
    }
    entries.push({
      name,
      path,
      bytes: details.size,
      sha256: sha256.digest("hex"),
      sha512: sha512.digest("hex"),
    });
  }
  await verifyDownloadedRelease(
    {
      repository: "OKFred/one-fetch",
      version: options.version,
      channel: "preview",
      commit: options.commit,
    },
    entries,
  );
  const manifest = JSON.parse(
    await readFile(
      join(directory, `one-fetch-release-manifest-${options.version}.json`),
      "utf8",
    ),
  );
  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    [
      ...manifest.artifacts.map((e) => e.name),
      `one-fetch-release-manifest-${options.version}.json`,
      "SHA256SUMS",
      "SHA512SUMS",
    ].sort(),
  );
  const archive = entries.find(
    (e) => e.name === `one-fetch-node-${options.version}.tar.gz`,
  );
  const oci = entries.find(
    (e) => e.name === `one-fetch-node-${options.version}.oci.tar`,
  );
  if (!archive || !oci) throw new Error("Runtime archives are missing");
  const deploy = entries.find(
    (e) => e.name === `one-fetch-node-deploy-${options.version}.mjs`,
  );
  if (!deploy) throw new Error("Standalone deployment helper is missing");
  const tar = (...args) =>
    execFileSync("tar", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const index = JSON.parse(tar("-xOf", oci.path, "index.json"));
  assert.equal(index.manifests.length, 1);
  assert.equal(index.manifests[0].digest, options.image);
  assertSafeArchiveEntries(
    tar("-tzf", archive.path).split(/\r?\n/u).filter(Boolean),
    tar("-tvzf", archive.path),
  );
  const metadata = JSON.parse(
    tar("-xOzf", archive.path, "one-fetch/BUILD-METADATA.json"),
  );
  assert.equal(metadata.version, options.version);
  assert.equal(metadata.entrypoint, "dist/cli.js");
  return {
    archive,
    oci,
    deploy,
    manifestSha256: entries.find(
      (e) => e.name === `one-fetch-release-manifest-${options.version}.json`,
    ).sha256,
  };
}

export function assertRuntimeImage(labels, options, user) {
  if (
    labels?.["org.opencontainers.image.revision"] !== options.commit ||
    labels?.["org.opencontainers.image.version"] !== options.version ||
    labels?.["org.opencontainers.image.source"] !==
      "https://github.com/OKFred/one-fetch" ||
    user !== "node"
  )
    throw new Error("Loaded image identity or non-root user mismatch");
}

export function loopbackPublishedOrigin(value) {
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(value.trim());
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535)
    throw new Error("Expected one loopback-only published port");
  return `http://127.0.0.1:${match[1]}`;
}
