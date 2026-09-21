import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { assertSafeArchiveEntries } from "../deploy/node.mjs";

export async function checkedFile(path, maximumBytes = 32 * 1024 * 1024) {
  const details = await lstat(path);
  assert.ok(details.isFile() && !details.isSymbolicLink());
  assert.ok(details.size > 0 && details.size <= maximumBytes);
  const bytes = await readFile(path);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function validateUpgradeMetadata(value) {
  assert.equal(value.schemaVersion, 1);
  assert.match(value.version, /^0\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u);
  assert.equal(value.source.repository, "https://github.com/OKFred/one-fetch");
  assert.match(value.source.commit, /^[a-f0-9]{40}$/u);
  assert.equal(value.source.dirty, false);
  assert.equal(
    value.archive.filename,
    `one-fetch-node-${value.version}.tar.gz`,
  );
  assert.match(value.archive.sha256, /^[a-f0-9]{64}$/u);
  assert.match(value.deploymentHelper.sha256, /^[a-f0-9]{64}$/u);
  return value;
}

export async function inspectUpgradeArchive(archivePath, metadataPath) {
  const metadata = validateUpgradeMetadata(
    JSON.parse(
      (await checkedFile(metadataPath, 64 * 1024)).bytes.toString("utf8"),
    ),
  );
  assert.equal(basename(archivePath), metadata.archive.filename);
  const archive = await checkedFile(archivePath);
  assert.equal(archive.sha256, metadata.archive.sha256);
  const tar = (...args) =>
    execFileSync("tar", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  assertSafeArchiveEntries(
    tar("-tzf", archivePath).split(/\r?\n/u).filter(Boolean),
    tar("-tvzf", archivePath),
  );
  const read = (file) =>
    JSON.parse(tar("-xOzf", archivePath, `one-fetch/${file}`));
  assert.equal(read("package.json").name, "@one-fetch/adapter-node");
  assert.equal(read("package.json").version, metadata.version);
  assert.equal(read("BUILD-METADATA.json").version, metadata.version);
  return metadata;
}

export function parseUpgradeArguments(values) {
  const keys = [
    "from-archive",
    "from-metadata",
    "to-archive",
    "to-metadata",
    "helper",
    "image",
    "platform",
    "output",
  ];
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]?.replace(/^--/u, "");
    const value = values[index + 1];
    assert.ok(values[index]?.startsWith("--") && keys.includes(name));
    assert.ok(value && !value.startsWith("--") && options[name] === undefined);
    options[name] = value;
  }
  assert.ok(keys.every((key) => options[key]));
  assert.match(options.image, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(["linux/amd64", "linux/arm64"].includes(options.platform));
  return options;
}
