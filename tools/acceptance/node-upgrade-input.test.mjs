import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertUpgradeTargetResponse } from "./node-upgrade-session.mjs";
import {
  checkedFile,
  parseUpgradeArguments,
  validateUpgradeMetadata,
} from "./node-upgrade-input.mjs";

const metadata = () => ({
  schemaVersion: 1,
  version: "0.1.1",
  source: {
    repository: "https://github.com/OKFred/one-fetch",
    commit: "a".repeat(40),
    dirty: false,
  },
  archive: { filename: "one-fetch-node-0.1.1.tar.gz", sha256: "b".repeat(64) },
  deploymentHelper: { sha256: "c".repeat(64) },
});

test("upgrade checks signed target headers without flattening Set-Cookie", () => {
  const result = {
    status: 201,
    text: JSON.stringify({
      url: "/arbitrary/v1?key=one&key=two",
      method: "POST",
      body: '{"synthetic":true}',
    }),
    classification: {
      source: "target",
      target: {
        headers: [
          { name: "Set-Cookie", value: "first=synthetic" },
          { name: "Set-Cookie", value: "second=synthetic" },
          { name: "Server-Timing", value: "synthetic;dur=1" },
        ],
      },
    },
  };
  assertUpgradeTargetResponse(result);
  assert.throws(() =>
    assertUpgradeTargetResponse({
      ...result,
      classification: { source: "intermediary" },
    }),
  );
  result.classification.target.headers.shift();
  assert.throws(() => assertUpgradeTargetResponse(result));
});

test("upgrade accepts only exact clean build metadata", () => {
  assert.equal(validateUpgradeMetadata(metadata()).version, "0.1.1");
  for (const mutate of [
    (value) => {
      value.source.dirty = true;
    },
    (value) => {
      value.source.commit = "main";
    },
    (value) => {
      value.source.repository = "https://example.com";
    },
    (value) => {
      value.version = "latest";
    },
    (value) => {
      value.archive.filename = "one-fetch-node-0.1.0.tar.gz";
    },
    (value) => {
      value.archive.sha256 = "invalid";
    },
    (value) => {
      value.deploymentHelper.sha256 = undefined;
    },
  ]) {
    const value = metadata();
    mutate(value);
    assert.throws(() => validateUpgradeMetadata(value));
  }
});

test("upgrade CLI requires explicit identities and rejects ambiguous input", () => {
  const args = [
    "--from-archive",
    "old",
    "--from-metadata",
    "old-json",
    "--to-archive",
    "new",
    "--to-metadata",
    "new-json",
    "--helper",
    "helper",
    "--image",
    `sha256:${"a".repeat(64)}`,
    "--platform",
    "linux/amd64",
    "--output",
    "receipt.json",
  ];
  assert.equal(parseUpgradeArguments(args).platform, "linux/amd64");
  assert.equal(parseUpgradeArguments(args).scenario, "standard");
  assert.equal(
    parseUpgradeArguments([...args, "--scenario", "interrupted"]).scenario,
    "interrupted",
  );
  assert.throws(() =>
    parseUpgradeArguments([...args, "--scenario", "unknown"]),
  );
  assert.throws(() => parseUpgradeArguments(args.slice(0, -2)));
  assert.throws(() =>
    parseUpgradeArguments([...args, "--output", "second.json"]),
  );
  assert.throws(() => parseUpgradeArguments([...args, "--unknown", "value"]));
  assert.throws(() =>
    parseUpgradeArguments(
      args.map((value) =>
        value.startsWith("sha256:") ? "node:latest" : value,
      ),
    ),
  );
  assert.throws(() =>
    parseUpgradeArguments(
      args.map((value) => (value === "linux/amd64" ? "windows/amd64" : value)),
    ),
  );
});

test("upgrade input files are bounded and nonempty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-upgrade-input-"));
  try {
    const path = join(directory, "input");
    await writeFile(path, "synthetic");
    assert.match((await checkedFile(path)).sha256, /^[a-f0-9]{64}$/u);
    await assert.rejects(checkedFile(path, 1));
    await assert.rejects(checkedFile(directory));
    await writeFile(path, "");
    await assert.rejects(checkedFile(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
